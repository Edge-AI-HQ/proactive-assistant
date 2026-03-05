import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import Docker from "dockerode";
import { getContainerManagerRuntime } from "../../runtime.js";
import type {
  ContainerManagerConfig,
  ReadAssistantLiteLLMVirtualKey,
} from "../../types.js";
import type {
  AssistantContainerParams,
  ContainerRef,
  ContainerRuntime,
  ContainerState,
  GatewayTarget,
  ProbeOptions,
} from "../../contracts.js";
import { buildAssistantOpenclawConfig } from "../shared/openclaw_config.js";
import { resolveAssistantLiteLLMApiKey as resolveAssistantLiteLLMApiKeyShared } from "../shared/assistant_litellm_key.js";
import { DOCKER_FORBIDDEN_SECRET_ENV_KEYS } from "../shared/secret_env.js";
import {
  assertNoP0SecretsInConfig,
  assertNoP0SecretsInEnv,
} from "../shared/secret_guard.js";
import {
  deriveAssistantWebhookSecret,
  QUICKSTART_SYNTHETIC_BOT_TOKEN,
} from "../shared/telegram_runtime_secret.js";
import { config as appConfig } from "../../../common/config.js";
import { toOpenclawSkillsPayload } from "../../../skills/openclaw_skills.js";

// ---------------------------------------------------------------------------
// Docker client & config proxy
// ---------------------------------------------------------------------------

const docker = new Docker();

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) =>
    getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig],
});

const readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey = (
  assistant,
) => getContainerManagerRuntime().readAssistantLiteLLMVirtualKey(assistant);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const isStatusCodeError = (value: unknown): value is DockerStatusCodeError =>
  isRecord(value) && typeof value.statusCode === "number";

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const hasEnvKey = (envVars: string[] | undefined, key: string): boolean =>
  findEnvValue(envVars, key) !== null;

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
    if (containerTarget === target && source) return source;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Container directory management
// ---------------------------------------------------------------------------

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
): AssistantContainerDirs => buildContainerDirs(`assistant-${assistantBotId}`);

// ---------------------------------------------------------------------------
// Cron store sanitization
// ---------------------------------------------------------------------------

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
  fs.writeFileSync(
    cronPath,
    `${JSON.stringify({ ...parsed, jobs }, null, 2)}\n`,
  );
};

// ---------------------------------------------------------------------------
// OpenClaw config management
// ---------------------------------------------------------------------------

const mergeAssistantOpenclawConfig = (
  existingParsed: UnknownRecord,
  desired: UnknownRecord,
  assistantBotToken: string,
): UnknownRecord => {
  const next: UnknownRecord = { ...existingParsed };

  next.gateway = desired.gateway;

  const existingMessages = isRecord(next.messages) ? next.messages : {};
  const desiredMessages = isRecord(desired.messages) ? desired.messages : {};
  next.messages = { ...existingMessages, tts: desiredMessages.tts };

  const desiredTalk = isRecord(desired.talk) ? desired.talk : null;
  if (desiredTalk) {
    const existingTalk = isRecord(next.talk) ? next.talk : {};
    const mergedTalk: UnknownRecord = { ...existingTalk, ...desiredTalk };
    if (Object.hasOwn(mergedTalk, "baseUrl")) delete mergedTalk.baseUrl;
    next.talk = mergedTalk;
  }

  const normalizedAssistantBotToken = assistantBotToken.trim();
  if (normalizedAssistantBotToken) {
    const existingChannels = isRecord(next.channels) ? next.channels : {};
    const desiredChannels = isRecord(desired.channels) ? desired.channels : {};
    next.channels = { ...existingChannels, telegram: desiredChannels.telegram };
  } else if (isRecord(desired.channels)) {
    // Quick Start mode (no dedicated bot token): take channels from desired
    // config, which may include webhook listener settings.
    next.channels = desired.channels;
  } else if (isRecord(next.channels)) {
    const nextChannels: UnknownRecord = { ...next.channels };
    if (Object.hasOwn(nextChannels, "telegram")) {
      delete nextChannels.telegram;
      next.channels = Object.keys(nextChannels).length
        ? nextChannels
        : undefined;
    }
  }

  // Always take plugins and session config from desired — these are generated
  // fresh each time and include webhook-related plugins.
  if (isRecord(desired.plugins)) {
    next.plugins = desired.plugins;
  }
  if (isRecord(desired.session)) {
    next.session = desired.session;
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
      providers: { ...existingProviders, litellm: desiredProviders.litellm },
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
      defaults: { ...existingDefaults, model: desiredDefaults.model },
    };
  }

  if (isRecord(desired.skills)) {
    next.skills = desired.skills;
  } else if (Object.hasOwn(next, "skills")) {
    delete next.skills;
  }

  return next;
};

const ensureOpenclawConfig = (
  configDir: string,
  assistantBotId: number,
  gatewayToken: string,
  assistantBotToken?: string | null,
  liteLlmApiKey?: string | null,
  skillsConfig?: Record<string, unknown> | null,
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

  const webhookPort = config.telegramRouter.webhookPort;
  const privateWebhookPort = webhookPort + 1;
  const webhookPath = config.telegramRouter.webhookPath;
  const webhookHost = config.telegramRouter.webhookHost || "0.0.0.0";
  const webhookSecret = deriveAssistantWebhookSecret(
    assistantBotId,
    gatewayToken,
    appConfig.apiAuthToken,
  );
  const pluginPath = config.telegramRouter.pluginPath;
  const webhookUrl = config.telegramRouter.webhookUrl.trim();

  const desired = buildAssistantOpenclawConfig(config, {
    gatewayToken,
    gatewayBind: "lan",
    assistantBotToken: assistantBotToken ?? null,
    quickStartSyntheticBotToken: QUICKSTART_SYNTHETIC_BOT_TOKEN,
    liteLlmApiKey: liteLlmApiKey ?? null,
    includeTelegramPlugin: true,
    telegramWebhookMode: true,
    telegramWebhookPort: webhookPort,
    telegramPrivateWebhookPort: privateWebhookPort,
    telegramWebhookPath: webhookPath,
    telegramWebhookHost: webhookHost,
    telegramWebhookSecret: webhookSecret,
    ...(webhookUrl ? { telegramWebhookUrl: webhookUrl } : {}),
    ...(pluginPath ? { telegramRouterPluginPath: pluginPath } : {}),
    controlOrigin: appConfig.publicBaseUrl,
    ...(skillsConfig ? { skillsConfig: toOpenclawSkillsPayload(skillsConfig) } : {}),
  });
  const next = mergeAssistantOpenclawConfig(
    existingParsed,
    desired,
    assistantBotToken || "",
  );
  assertNoP0SecretsInConfig(next, config);

  const changed = JSON.stringify(existingParsed) !== JSON.stringify(next);
  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  }
  return { configPath, changed };
};

// ---------------------------------------------------------------------------
// Docker runtime preparation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Port probe
// ---------------------------------------------------------------------------

const waitForLocalPort = (
  port: number,
  timeoutMs = 30_000,
): Promise<boolean> =>
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

// ---------------------------------------------------------------------------
// Internal: container resolution & state normalization
// ---------------------------------------------------------------------------

const resolveDockerContainer = async (
  containerId: string | null | undefined,
  fallbackName: string,
): Promise<Docker.Container | null> => {
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

const normalizeDockerState = (status: string | undefined): ContainerState => {
  const s = (status || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "exited" || s === "dead") return "stopped";
  if (s === "created" || s === "restarting") return "creating";
  if (s === "removing") return "missing";
  return "unknown";
};

const inspectToContainerRef = async (
  container: Docker.Container,
): Promise<ContainerRef> => {
  const inspect = await container.inspect();
  const envArr: string[] = inspect.Config?.Env || [];
  const env: Record<string, string> = {};
  for (const entry of envArr) {
    const idx = entry.indexOf("=");
    if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }

  // Extract host ports from bindings
  const portBindings = inspect.HostConfig?.PortBindings || {};
  const metadata: Record<string, string> = {};

  const extractHostPort = (containerPort: string): string => {
    const bindings = portBindings[containerPort];
    if (Array.isArray(bindings) && bindings.length > 0) {
      const binding = bindings[0] as { HostPort?: string };
      if (binding.HostPort) return binding.HostPort;
    }
    return "";
  };

  metadata.hostPort = extractHostPort(`${config.openclaw.gatewayPort}/tcp`);
  const webhookPort = config.telegramRouter.webhookPort;
  metadata.webhookHostPort = extractHostPort(`${webhookPort}/tcp`);
  metadata.privateWebhookHostPort = extractHostPort(
    `${webhookPort + 1}/tcp`,
  );

  return {
    id: inspect.Id,
    name: (inspect.Name || "").replace(/^\//, ""),
    state: normalizeDockerState(inspect.State?.Status),
    env,
    image: inspect.Config?.Image,
    metadata,
  };
};

// ---------------------------------------------------------------------------
// ContainerRuntime implementation
// ---------------------------------------------------------------------------

export const dockerContainerRuntime: ContainerRuntime = {
  name: "docker",

  async prepare(): Promise<void> {
    prepareDockerRuntime();
  },

  async findContainer(
    currentRef: string | null,
    fallbackNames: string[],
  ): Promise<ContainerRef | null> {
    // Try currentRef first
    if (currentRef) {
      try {
        const container = docker.getContainer(currentRef);
        const inspect = await container.inspect();
        if (inspect) return inspectToContainerRef(container);
      } catch {
        // fall through
      }
    }

    // Try each fallback name
    for (const name of fallbackNames) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      try {
        const container = docker.getContainer(trimmed);
        const inspect = await container.inspect();
        if (inspect) return inspectToContainerRef(container);
      } catch {
        // continue
      }
    }

    return null;
  },

  async createContainer(
    params: AssistantContainerParams,
  ): Promise<ContainerRef> {
    const dirs = getAssistantContainerDirs(params.assistantBotId);
    ensureDir(dirs.configDir);
    ensureDir(dirs.dataDir);
    ensureDir(dirs.tmpDir);
    ensureDir(dirs.workspaceDir);

    // Resolve LiteLLM key
    const liteLlmApiKey = params.liteLlmApiKey;

    ensureOpenclawConfig(
      dirs.configDir,
      params.assistantBotId,
      params.gatewayToken,
      params.assistantBotToken,
      liteLlmApiKey,
      params.skillsConfig,
    );
    sanitizeCronStore(dirs.dataDir);

    const hostPort = params.containerPort
      ? String(params.containerPort)
      : "0";

    const webhookPort = config.telegramRouter.webhookPort;
    const privateWebhookPort = webhookPort + 1;
    const webhookHostPort = params.containerPort
      ? String(params.containerPort + 1)
      : "0";
    const privateWebhookHostPort = params.containerPort
      ? String(params.containerPort + 2)
      : "0";

    // TELEGRAM_ROUTER_URL: where the telegram-router-proxy plugin forwards
    // outbound Telegram API calls. In Docker, the APIs server runs on the host.
    const apisPort = Number.parseInt(process.env.PORT || "3000", 10);
    const telegramRouterUrl = `http://host.docker.internal:${apisPort}`;
    const containerEnv: Record<string, string> = {
      OPENCLAW_USER_ID: `assistant-${params.assistantBotId}`,
      OPENCLAW_GATEWAY_PORT: String(config.openclaw.gatewayPort),
      OPENCLAW_TELEGRAM_WEBHOOK_PORT: String(webhookPort),
      OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT: String(privateWebhookPort),
      OPENCLAW_CONFIG_PATH: "/app/config/openclaw.json",
      OPENCLAW_STATE_DIR: "/app/data",
      NODE_COMPILE_CACHE: "/app/data/cache/node-compile-cache",
      TELEGRAM_ROUTER_URL: telegramRouterUrl,
    };
    assertNoP0SecretsInEnv(containerEnv, config);

    const container = await docker.createContainer({
      name: params.containerName,
      Image: config.openclaw.image,
      Env: Object.entries(containerEnv).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: {
        [`${config.openclaw.gatewayPort}/tcp`]: {},
        [`${webhookPort}/tcp`]: {},
        [`${privateWebhookPort}/tcp`]: {},
      },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: {
          [`${config.openclaw.gatewayPort}/tcp`]: [{ HostPort: hostPort }],
          [`${webhookPort}/tcp`]: [{ HostPort: webhookHostPort }],
          [`${privateWebhookPort}/tcp`]: [{ HostPort: privateWebhookHostPort }],
        },
        Binds: [
          `${dirs.configDir}:/app/config`,
          `${dirs.dataDir}:/app/data`,
          `${dirs.tmpDir}:/tmp`,
          `${dirs.workspaceDir}:/root/.openclaw/workspace`,
        ],
        Memory: config.container.memoryMb * 1024 * 1024,
        CpuShares: config.container.cpuShares,
      },
    });

    return inspectToContainerRef(container);
  },

  async startContainer(containerId: string): Promise<ContainerRef> {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();

    if (inspect.State.Status !== "running") {
      try {
        await container.start();
      } catch (error: unknown) {
        if (!isStatusCodeError(error) || error.statusCode !== 304) throw error;
      }
    }

    return inspectToContainerRef(container);
  },

  async stopContainer(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
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
  },

  async destroyContainer(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
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
    } catch (error: unknown) {
      if (!isStatusCodeError(error) || error.statusCode !== 404) throw error;
    }
  },

  async listContainers(): Promise<ContainerRef[]> {
    const containers = await docker.listContainers({ all: true });
    return containers.map((info) => ({
      id: info.Id,
      name: (info.Names?.[0] || "").replace(/^\//, ""),
      state: normalizeDockerState(info.State),
      metadata: {},
    }));
  },

  resolveGatewayTarget(ref: ContainerRef): GatewayTarget {
    const hostPort = Number(ref.metadata.hostPort) || config.openclaw.gatewayPort;
    return {
      host: "127.0.0.1",
      port: hostPort,
      httpBaseUrl: `http://127.0.0.1:${hostPort}`,
      wsBaseUrl: `ws://127.0.0.1:${hostPort}`,
    };
  },

  async probeReady(
    ref: ContainerRef,
    options: ProbeOptions,
  ): Promise<boolean> {
    const hostPort = Number(ref.metadata.hostPort) || options.gatewayPort;
    const gatewayReady = await waitForLocalPort(hostPort, options.timeoutMs);
    if (!gatewayReady) return false;

    // Also probe the webhook host port if exposed
    const webhookHostPort = Number(ref.metadata.webhookHostPort);
    if (webhookHostPort > 0) {
      const webhookReady = await waitForLocalPort(webhookHostPort, 120_000);
      if (!webhookReady) return false;
    }

    return true;
  },

  async needsRecreation(
    ref: ContainerRef,
    params: AssistantContainerParams,
  ): Promise<boolean> {
    let container: Docker.Container;
    try {
      container = docker.getContainer(ref.id);
    } catch {
      return true;
    }

    let inspect: Awaited<ReturnType<Docker.Container["inspect"]>>;
    try {
      inspect = await container.inspect();
    } catch {
      return true;
    }

    const dirs = getAssistantContainerDirs(params.assistantBotId);
    const binds = inspect?.HostConfig?.Binds;
    const expectedBinds: Array<{ target: string; source: string }> = [
      { target: "/app/config", source: dirs.configDir },
      { target: "/app/data", source: dirs.dataDir },
      { target: "/tmp", source: dirs.tmpDir },
      { target: "/root/.openclaw/workspace", source: dirs.workspaceDir },
    ];
    const needsBindMigration = expectedBinds.some(({ target, source }) => {
      const mountedSource = findBindSource(binds, target);
      return mountedSource !== source;
    });
    if (needsBindMigration) return true;

    const legacyTelegramBotToken = findEnvValue(
      inspect?.Config?.Env,
      "TELEGRAM_BOT_TOKEN",
    );
    if (
      typeof legacyTelegramBotToken === "string" &&
      legacyTelegramBotToken.length > 0
    ) {
      return true;
    }

    // Recreate if webhook port is not exposed (legacy containers before webhook fix)
    const webhookPort = config.telegramRouter.webhookPort;
    const exposedPorts = inspect?.Config?.ExposedPorts || {};
    if (!exposedPorts[`${webhookPort}/tcp`]) {
      return true;
    }

    const needsSecretEnvPrune = DOCKER_FORBIDDEN_SECRET_ENV_KEYS.some((key) =>
      hasEnvKey(inspect?.Config?.Env, key),
    );
    if (needsSecretEnvPrune) return true;

    // Write updated config and check if restart is needed
    const liteLlmApiKey = params.liteLlmApiKey;
    const { changed } = ensureOpenclawConfig(
      dirs.configDir,
      params.assistantBotId,
      params.gatewayToken,
      params.assistantBotToken,
      liteLlmApiKey,
      params.skillsConfig,
    );

    // Config change doesn't need recreation — just a restart (handled by orchestrator)
    // But we sanitize cron store as a side effect
    sanitizeCronStore(dirs.dataDir);

    // If config changed and container is running, orchestrator should restart
    // We return false because recreation (destroy+create) is not needed
    if (changed) {
      // Restart the running container to pick up config changes
      if (inspect.State?.Status === "running") {
        await container.restart();
      }
    }

    return false;
  },
};
