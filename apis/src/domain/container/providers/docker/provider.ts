import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import Docker from "dockerode";
import type Dockerode from "dockerode";
import { getContainerManagerRuntime } from "../../runtime.js";
import type {
  AssistantRecord,
  ContainerManagerConfig,
  ReadAssistantLiteLLMVirtualKey,
} from "../../types.js";
import type {
  AssistantContainerDestroyRef,
  AssistantContainerGatewayRef,
  AssistantContainerRuntimeRef,
  ContainerProvider,
  GatewayTarget,
} from "../../contracts.js";
import { containerNameForAssistant } from "../../naming.js";
import { buildAssistantOpenclawConfig } from "../shared/openclaw_config.js";
import { resolveAssistantLiteLLMApiKey as resolveAssistantLiteLLMApiKeyShared } from "../shared/assistant_litellm_key.js";
import { DOCKER_FORBIDDEN_SECRET_ENV_KEYS } from "../shared/secret_env.js";

const docker = new Docker();

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) =>
    getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig],
});

const updateAssistant = (id: number, fields: Partial<AssistantRecord>) =>
  getContainerManagerRuntime().store.updateAssistant(id, fields);
const readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey = (
  assistant,
) => getContainerManagerRuntime().readAssistantLiteLLMVirtualKey(assistant);

type UnknownRecord = Record<string, unknown>;

interface ParsedCronStore {
  jobs: unknown[];
}

interface DockerStatusCodeError {
  statusCode?: number;
}

interface AssistantContainerDirs {
  configDir: string;
  dataDir: string;
  tmpDir: string;
  workspaceDir: string;
}

const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === "object" && value !== null;
};

const isStatusCodeError = (value: unknown): value is DockerStatusCodeError => {
  return isRecord(value) && typeof value.statusCode === "number";
};

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const resolveAssistantLiteLLMApiKey = (
  assistant: AssistantContainerRuntimeRef,
): string | null =>
  resolveAssistantLiteLLMApiKeyShared(
    assistant,
    config.litellm.enabled,
    readAssistantLiteLLMVirtualKey,
  );

const hasEnvKey = (envVars: string[] | undefined, key: string): boolean => {
  return findEnvValue(envVars, key) !== null;
};

const mergeAssistantOpenclawConfig = (
  existingParsed: UnknownRecord,
  desired: UnknownRecord,
  assistantBotToken: string,
): UnknownRecord => {
  const next: UnknownRecord = { ...existingParsed };

  next.gateway = desired.gateway;

  const existingMessages = isRecord(next.messages) ? next.messages : {};
  const desiredMessages = isRecord(desired.messages) ? desired.messages : {};
  next.messages = {
    ...existingMessages,
    tts: desiredMessages.tts,
  };

  const desiredTalk = isRecord(desired.talk) ? desired.talk : null;
  if (desiredTalk) {
    const existingTalk = isRecord(next.talk) ? next.talk : {};
    const mergedTalk: UnknownRecord = { ...existingTalk, ...desiredTalk };
    if (Object.hasOwn(mergedTalk, "baseUrl")) {
      delete mergedTalk.baseUrl;
    }
    next.talk = mergedTalk;
  }

  const normalizedAssistantBotToken = assistantBotToken.trim();
  if (normalizedAssistantBotToken) {
    const existingChannels = isRecord(next.channels) ? next.channels : {};
    const desiredChannels = isRecord(desired.channels) ? desired.channels : {};
    next.channels = {
      ...existingChannels,
      telegram: desiredChannels.telegram,
    };
  } else if (isRecord(next.channels)) {
    const nextChannels: UnknownRecord = { ...next.channels };
    if (Object.hasOwn(nextChannels, "telegram")) {
      delete nextChannels.telegram;
      if (Object.keys(nextChannels).length) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
    }
  }

  if (config.litellm.enabled) {
    const desiredModels = isRecord(desired.models) ? desired.models : {};
    const desiredProviders = isRecord(desiredModels.providers)
      ? desiredModels.providers
      : {};
    const existingModels = isRecord(next.models) ? next.models : {};
    const existingProviders = isRecord(existingModels.providers)
      ? existingModels.providers
      : {};
    next.models = {
      ...existingModels,
      providers: {
        ...existingProviders,
        litellm: desiredProviders.litellm,
      },
    };

    const desiredAgents = isRecord(desired.agents) ? desired.agents : {};
    const desiredDefaults = isRecord(desiredAgents.defaults)
      ? desiredAgents.defaults
      : {};
    const existingAgents = isRecord(next.agents) ? next.agents : {};
    const existingDefaults = isRecord(existingAgents.defaults)
      ? existingAgents.defaults
      : {};
    next.agents = {
      ...existingAgents,
      defaults: {
        ...existingDefaults,
        model: desiredDefaults.model,
      },
    };
  }

  return next;
};

const ensureOpenclawConfig = (
  configDir: string,
  gatewayToken: string,
  assistantBotToken?: string | null,
  liteLlmApiKey?: string | null,
): { configPath: string; changed: boolean } => {
  const configPath = path.join(configDir, "openclaw.json");
  const existingRaw = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const existingParsed = (() => {
    if (!existingRaw) return {};
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();

  const desired = buildAssistantOpenclawConfig(config, {
    gatewayToken,
    gatewayBind: "lan",
    assistantBotToken: assistantBotToken ?? null,
    liteLlmApiKey: liteLlmApiKey ?? null,
    includeTelegramPlugin: false,
  });
  const next = mergeAssistantOpenclawConfig(
    existingParsed,
    desired,
    assistantBotToken || "",
  );

  const changed = JSON.stringify(existingParsed) !== JSON.stringify(next);
  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  }
  return { configPath, changed };
};

const parseCronStore = (raw: string): ParsedCronStore | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) return null;
    return { jobs: parsed.jobs };
  } catch {
    return null;
  }
};

const sanitizeCronStore = (runtimeDataDir: string): void => {
  const cronPath = path.join(runtimeDataDir, "cron", "jobs.json");
  if (!fs.existsSync(cronPath)) return;

  const parsed = parseCronStore(fs.readFileSync(cronPath, "utf8"));
  if (!parsed) return;

  let changed = false;
  const jobs = parsed.jobs.map((job) => {
    if (!isRecord(job)) return job;
    const next: UnknownRecord = { ...job };

    if (isRecord(next.delivery) && next.delivery.mode !== "none") {
      next.delivery = { ...next.delivery, mode: "none" };
      changed = true;
    }

    if (
      isRecord(next.payload) &&
      Object.hasOwn(next.payload, "deliver") &&
      next.payload.deliver !== false
    ) {
      next.payload = { ...next.payload, deliver: false };
      changed = true;
    }

    return next;
  });

  if (!changed) return;

  const updated = {
    ...parsed,
    jobs,
  };

  fs.writeFileSync(cronPath, `${JSON.stringify(updated, null, 2)}\n`);
};

const buildContainerDirs = (scopeDirName: string): AssistantContainerDirs => {
  const baseDir = path.join(process.cwd(), "data", scopeDirName);
  return {
    configDir: path.join(baseDir, "config"),
    dataDir: path.join(baseDir, "data"),
    tmpDir: path.join(baseDir, "tmp"),
    workspaceDir: path.join(baseDir, "workspace"),
  };
};

const getAssistantContainerDirs = (
  assistantBotId: number,
): AssistantContainerDirs => {
  return buildContainerDirs(`assistant-${assistantBotId}`);
};

const prepareDockerRuntime = (): void => {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) return;

  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    if (!entry.name.startsWith("assistant-")) return;
    const runtimeDataDir = path.join(dataDir, entry.name, "data");
    if (!fs.existsSync(runtimeDataDir)) return;
    sanitizeCronStore(runtimeDataDir);
  });
};

const waitForPort = (port: number, timeoutMs = 30000): Promise<boolean> =>
  new Promise((resolve) => {
    const start = Date.now();

    const tryConnect = (): void => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });

      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(tryConnect, 1000);
        }
      });
    };

    tryConnect();
  });

const resolveDockerGatewayTargetForAssistant = (
  assistant: AssistantContainerGatewayRef,
): GatewayTarget => {
  return {
    host: "127.0.0.1",
    port: assistant.container_port,
    httpBaseUrl: `http://127.0.0.1:${assistant.container_port}`,
    wsBaseUrl: `ws://127.0.0.1:${assistant.container_port}`,
  };
};

const resolveContainer = async (
  containerId: string | null | undefined,
  fallbackName: string,
): Promise<Dockerode.Container | null> => {
  if (containerId) {
    try {
      const container = docker.getContainer(containerId);
      await container.inspect();
      return container;
    } catch {
      // fall through to fallback lookup
    }
  }

  try {
    const container = docker.getContainer(fallbackName);
    await container.inspect();
    return container;
  } catch {
    return null;
  }
};

const findBindSource = (
  binds: string[] | undefined,
  target: string,
): string | null => {
  if (!Array.isArray(binds)) return null;
  for (const bind of binds) {
    const parts = bind.split(":");
    if (parts.length < 2) continue;
    const source = parts[0];
    const containerTarget = parts[1];
    if (containerTarget === target && source) {
      return source;
    }
  }
  return null;
};

const findEnvValue = (
  envVars: string[] | undefined,
  key: string,
): string | null => {
  if (!Array.isArray(envVars)) return null;
  const prefix = `${key}=`;
  for (const variable of envVars) {
    if (!variable.startsWith(prefix)) continue;
    return variable.slice(prefix.length);
  }
  return null;
};

const ensureAssistantDockerContainer = async (
  assistant: AssistantContainerRuntimeRef,
  gatewayToken: string,
): Promise<{ containerId: string; ready: boolean }> => {
  // Quick Start 模式下 assistant_bot_id 为 NULL，使用 assistant.id 作为标识
  const botIdForContainer = assistant.assistant_bot_id ?? assistant.id;

  const fallbackContainerName = containerNameForAssistant(botIdForContainer);
  const containerName =
    assistant.container_name?.trim() || fallbackContainerName;
  let container = await resolveContainer(assistant.container_id, containerName);

  const assistantDirs = getAssistantContainerDirs(botIdForContainer);
  const assistantConfigDir = assistantDirs.configDir;
  const assistantDataDir = assistantDirs.dataDir;
  const assistantTmpDir = assistantDirs.tmpDir;
  const assistantWorkspaceDir = assistantDirs.workspaceDir;

  ensureDir(assistantConfigDir);
  ensureDir(assistantDataDir);
  ensureDir(assistantTmpDir);
  ensureDir(assistantWorkspaceDir);
  const assistantLiteLLMApiKey = resolveAssistantLiteLLMApiKey(assistant);
  const { changed: configChanged } = ensureOpenclawConfig(
    assistantConfigDir,
    gatewayToken,
    assistant.assistant_bot_token,
    assistantLiteLLMApiKey,
  );
  sanitizeCronStore(assistantDataDir);
  let shouldRestartForConfig = false;

  if (container) {
    const inspect = await container.inspect();
    const binds = inspect?.HostConfig?.Binds;
    const expectedBinds: Array<{ target: string; source: string }> = [
      { target: "/app/config", source: assistantConfigDir },
      { target: "/app/data", source: assistantDataDir },
      { target: "/tmp", source: assistantTmpDir },
      { target: "/root/.openclaw/workspace", source: assistantWorkspaceDir },
    ];
    const needsBindMigration = expectedBinds.some(({ target, source }) => {
      const mountedSource = findBindSource(binds, target);
      return mountedSource !== source;
    });
    const legacyTelegramBotToken = findEnvValue(
      inspect?.Config?.Env,
      "TELEGRAM_BOT_TOKEN",
    );
    const needsEnvMigration =
      typeof legacyTelegramBotToken === "string" &&
      legacyTelegramBotToken.length > 0;
    const needsSecretEnvPrune = DOCKER_FORBIDDEN_SECRET_ENV_KEYS.some((key) =>
      hasEnvKey(inspect?.Config?.Env, key),
    );

    if (needsBindMigration || needsEnvMigration || needsSecretEnvPrune) {
      try {
        if (inspect.State?.Status === "running") {
          await container.stop();
        }
      } catch {
        // continue with forced remove
      }
      await container.remove({ force: true });
      container = null;
      await updateAssistant(assistant.id, {
        container_status: "creating",
        container_id: "",
        container_name: containerName,
      });
    } else if (configChanged && inspect.State?.Status === "running") {
      shouldRestartForConfig = true;
    }
  }

  if (!container) {
    container = await docker.createContainer({
      name: containerName,
      Image: config.openclaw.image,
      Env: [
        `OPENCLAW_USER_ID=assistant-${botIdForContainer}`,
        `OPENCLAW_GATEWAY_PORT=${config.openclaw.gatewayPort}`,
        "OPENCLAW_CONFIG_PATH=/app/config/openclaw.json",
        "OPENCLAW_STATE_DIR=/app/data",
      ],
      ExposedPorts: {
        [`${config.openclaw.gatewayPort}/tcp`]: {},
      },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: {
          [`${config.openclaw.gatewayPort}/tcp`]: [
            { HostPort: String(assistant.container_port) },
          ],
        },
        Binds: [
          `${assistantConfigDir}:/app/config`,
          `${assistantDataDir}:/app/data`,
          `${assistantTmpDir}:/tmp`,
          `${assistantWorkspaceDir}:/root/.openclaw/workspace`,
        ],
        Memory: config.container.memoryMb * 1024 * 1024,
        CpuShares: config.container.cpuShares,
      },
    });

    await updateAssistant(assistant.id, {
      container_status: "creating",
      container_id: container.id,
      container_name: containerName,
    });
  }

  const inspect = await container.inspect();
  if (inspect.State.Status !== "running") {
    try {
      await container.start();
    } catch (error: unknown) {
      if (!isStatusCodeError(error) || error.statusCode !== 304) {
        throw error;
      }
    }
  } else if (shouldRestartForConfig) {
    await container.restart();
  }

  const ready = await waitForPort(assistant.container_port, 30000);
  await updateAssistant(assistant.id, {
    container_status: ready ? "running" : "error",
    container_name: containerName,
  });

  return { containerId: container.id, ready };
};

const destroyAssistantDockerContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ deleted: boolean }> => {
  const botIdForContainer = assistant.assistant_bot_id ?? assistant.id;
  const fallbackContainerName = containerNameForAssistant(botIdForContainer);
  const containerName =
    assistant.container_name?.trim() || fallbackContainerName;

  const container = await resolveContainer(
    assistant.container_id,
    containerName,
  );
  if (!container) {
    await updateAssistant(assistant.id, {
      container_status: "missing",
      container_id: "",
      container_name: containerName,
    });
    return { deleted: false };
  }

  let deleted = false;
  try {
    const inspect = await container.inspect();
    if (inspect.State?.Status === "running") {
      try {
        await container.stop();
      } catch (error: unknown) {
        if (
          !isStatusCodeError(error) ||
          (error.statusCode !== 304 && error.statusCode !== 404)
        ) {
          throw error;
        }
      }
    }

    await container.remove({ force: true });
    deleted = true;
  } catch (error: unknown) {
    if (!isStatusCodeError(error) || error.statusCode !== 404) {
      throw error;
    }
  }

  await updateAssistant(assistant.id, {
    container_status: "missing",
    container_id: "",
    container_name: containerName,
  });

  return { deleted };
};

const stopAssistantDockerContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ stopped: boolean }> => {
  const botIdForContainer = assistant.assistant_bot_id ?? assistant.id;
  const fallbackContainerName = containerNameForAssistant(botIdForContainer);
  const containerName =
    assistant.container_name?.trim() || fallbackContainerName;

  const container = await resolveContainer(
    assistant.container_id,
    containerName,
  );
  if (!container) {
    await updateAssistant(assistant.id, {
      container_status: "missing",
      container_id: "",
      container_name: containerName,
    });
    return { stopped: false };
  }

  let stopped = false;
  try {
    const inspect = await container.inspect();
    if (inspect.State?.Status === "running") {
      await container.stop();
      stopped = true;
    }
  } catch (error: unknown) {
    if (
      !isStatusCodeError(error) ||
      (error.statusCode !== 304 && error.statusCode !== 404)
    ) {
      throw error;
    }
  }

  await updateAssistant(assistant.id, {
    container_status: "stopped",
    container_name: containerName,
  });

  return { stopped };
};

export const dockerContainerProvider: ContainerProvider = {
  prepareRuntime: prepareDockerRuntime,
  ensureAssistantContainer: ensureAssistantDockerContainer,
  destroyAssistantContainer: destroyAssistantDockerContainer,
  stopAssistantContainer: stopAssistantDockerContainer,
  resolveGatewayTargetForAssistant: resolveDockerGatewayTargetForAssistant,
};
