import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { getContainerManagerRuntime } from "../../runtime.js";
import type {
  ContainerManagerConfig,
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
import { DOCKER_FORBIDDEN_SECRET_ENV_KEYS } from "../shared/secret_env.js";
import {
  assertNoP0SecretsInConfig,
  assertNoP0SecretsInEnv,
} from "../shared/secret_guard.js";
import { QUICKSTART_SYNTHETIC_BOT_TOKEN } from "../shared/telegram_runtime_secret.js";
import {
  buildWebhookParams,
  buildBaseContainerEnv,
} from "../shared/webhook_params.js";
import { PINAI_WORKSPACE_STATUS_PORT } from "../shared/workspace_ready.js";
import { PINAI_GOOGLE_CREDENTIALS_B64_ENV } from "../shared/google_workspace_credentials.js";
import { probeGatewayReady, type ResolvedProbeTarget } from "../shared/gateway_probe.js";
import { config as appConfig } from "../../../common/config.js";
import { toOpenclawSkillsPayload } from "../../../skills/openclaw_skills.js";
import { renderUserProfileMarkdown } from "../../../onboarding/profile_bootstrap.js";

// ---------------------------------------------------------------------------
// Docker client & config proxy
// ---------------------------------------------------------------------------

const docker = new Docker();

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) =>
    getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig],
});

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
  baseDir: string;
  openclawDir: string;
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
    baseDir,
    openclawDir: path.join(baseDir, ".openclaw"),
    workspaceDir: path.join(baseDir, ".openclaw", "workspace"),
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

const ensureWorkspaceUserProfile = (
  workspaceDir: string,
  profileText?: string | null,
  profileSource?: "connector" | "privy" | null,
): boolean => {
  const userMdPath = path.join(workspaceDir, "USER.md");
  const legacyUserMdPath = path.join(workspaceDir, "user.md");
  const normalized = (profileText || "").trim();
  if (!normalized) {
    if (fs.existsSync(legacyUserMdPath)) {
      fs.rmSync(legacyUserMdPath, { force: true });
    }
    if (fs.existsSync(userMdPath)) {
      fs.rmSync(userMdPath, { force: true });
      return true;
    }
    return false;
  }

  const content = renderUserProfileMarkdown(
    normalized,
    profileSource || "connector",
  );
  const before = fs.existsSync(userMdPath)
    ? fs.readFileSync(userMdPath, "utf8")
    : "";
  if (before === content) {
    if (fs.existsSync(legacyUserMdPath)) {
      fs.rmSync(legacyUserMdPath, { force: true });
      return true;
    }
    return false;
  }

  fs.writeFileSync(userMdPath, content, "utf8");
  if (fs.existsSync(legacyUserMdPath)) {
    fs.rmSync(legacyUserMdPath, { force: true });
  }
  return true;
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

  if (isRecord(desired.talk)) {
    const existingTalk = isRecord(next.talk) ? next.talk : {};
    next.talk = { ...existingTalk, ...desired.talk };
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

  // Always take plugins from desired — generated fresh each time with
  // webhook-related plugins.
  if (isRecord(desired.plugins)) {
    next.plugins = desired.plugins;
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
      defaults: {
        ...existingDefaults,
        model: desiredDefaults.model,
        ...(desiredDefaults.models !== undefined
          ? { models: desiredDefaults.models }
          : {}),
      },
    };
  }

  if (isRecord(desired.skills)) {
    next.skills = desired.skills;
  } else if (Object.hasOwn(next, "skills")) {
    delete next.skills;
  }

  // Always take tools, commands, and browser from desired config
  if (isRecord(desired.tools)) {
    next.tools = desired.tools;
  }
  if (isRecord(desired.commands)) {
    next.commands = desired.commands;
  }
  if (isRecord(desired.browser)) {
    next.browser = desired.browser;
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

  const wp = buildWebhookParams(
    config,
    assistantBotId,
    gatewayToken,
    appConfig.apiAuthToken,
    "lan",
  );

  const desired = buildAssistantOpenclawConfig(config, {
    gatewayToken,
    gatewayBind: "lan",
    assistantBotToken: assistantBotToken ?? null,
    quickStartSyntheticBotToken: QUICKSTART_SYNTHETIC_BOT_TOKEN,
    liteLlmApiKey: liteLlmApiKey ?? null,
    includeTelegramPlugin: true,
    telegramWebhookMode: true,
    telegramWebhookPort: wp.webhookPort,
    telegramPrivateWebhookPort: wp.privateWebhookPort,
    telegramWebhookPath: wp.webhookPath,
    telegramWebhookHost: wp.webhookHost,
    telegramWebhookSecret: wp.webhookSecret,
    ...(wp.webhookUrl ? { telegramWebhookUrl: wp.webhookUrl } : {}),
    ...(wp.pluginPath ? { telegramRouterPluginPath: wp.pluginPath } : {}),
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
    // Cron store lives under .openclaw/ state dir
    const stateDir = path.join(dataDir, entry.name, ".openclaw");
    if (!fs.existsSync(stateDir)) return;
    sanitizeCronStore(stateDir);
  });
};

// ---------------------------------------------------------------------------
// Port mapping helper for probes
// ---------------------------------------------------------------------------

const resolveDockerProbeTarget = (
  ref: ContainerRef,
  options: ProbeOptions,
): ResolvedProbeTarget => {
  const hostPort = Number(ref.metadata.hostPort) || options.gatewayPort;

  // Map container-internal ports to host-mapped ports for additional TCP checks
  const additionalPorts: number[] = [];
  const webhookHostPort = Number(ref.metadata.webhookHostPort);
  if (webhookHostPort > 0) additionalPorts.push(webhookHostPort);

  // Map container-internal HTTP probes to host-mapped ports
  const httpProbes: Array<{ port: number; path: string }> = [];
  if (Array.isArray(options.httpProbes)) {
    for (const probe of options.httpProbes) {
      const containerPort = Number(probe.port);
      const mappedHostPort =
        containerPort === config.openclaw.gatewayPort
          ? Number(ref.metadata.hostPort)
          : containerPort === config.telegramRouter.webhookPort
            ? Number(ref.metadata.webhookHostPort)
            : containerPort === config.telegramRouter.webhookPort + 1
              ? Number(ref.metadata.privateWebhookHostPort)
              : containerPort === PINAI_WORKSPACE_STATUS_PORT
                ? Number(ref.metadata.workspaceStatusHostPort)
                : 0;
      if (mappedHostPort > 0) {
        httpProbes.push({ port: mappedHostPort, path: probe.path });
      }
    }
  }

  return { host: "127.0.0.1", gatewayPort: hostPort, additionalPorts, httpProbes };
};

// ---------------------------------------------------------------------------
// Internal: container resolution & state normalization
// ---------------------------------------------------------------------------

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
  metadata.workspaceStatusHostPort = extractHostPort(`${PINAI_WORKSPACE_STATUS_PORT}/tcp`);

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
    ensureDir(dirs.openclawDir);
    // Do NOT create workspace dir here — OpenClaw skips workspace init
    // if the directory already exists. For hot volumes (workspace already
    // has TOOLS.md), we write USER.md into the existing dir. For cold
    // volumes, we let OpenClaw create the workspace, and the entrypoint's
    // workspace_inject handles USER.md + TOOLS append afterward.

    const liteLlmApiKey = params.liteLlmApiKey;

    ensureOpenclawConfig(
      dirs.openclawDir,
      params.assistantBotId,
      params.gatewayToken,
      params.assistantBotToken,
      liteLlmApiKey,
      params.skillsConfig,
    );
    // Only write USER.md if workspace already exists (hot volume)
    if (fs.existsSync(dirs.workspaceDir)) {
      ensureWorkspaceUserProfile(
        dirs.workspaceDir,
        params.onboardingProfileText,
        params.onboardingProfileSource,
      );
    }
    sanitizeCronStore(dirs.openclawDir);

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
    const workspaceStatusHostPort = params.containerPort
      ? String(params.containerPort + 3)
      : "0";

    // TELEGRAM_ROUTER_URL: where the telegram-router-proxy plugin forwards
    // outbound Telegram API calls. In Docker, the APIs server runs on the host.
    const apisPort = Number.parseInt(process.env.PORT || "3000", 10);
    const telegramRouterUrl = `http://host.docker.internal:${apisPort}`;
    const containerEnv: Record<string, string> = buildBaseContainerEnv(
      config,
      params.assistantBotId,
      webhookPort,
      privateWebhookPort,
      telegramRouterUrl,
      "/app/google/gws-credentials.json",
      liteLlmApiKey,
    );
    containerEnv[PINAI_GOOGLE_CREDENTIALS_B64_ENV] = (params.googleCredentialsB64 || "").trim();
    assertNoP0SecretsInEnv(containerEnv, config);

    const container = await docker.createContainer({
      name: params.containerName,
      Image: config.openclaw.image,
      Env: Object.entries(containerEnv).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: {
        [`${config.openclaw.gatewayPort}/tcp`]: {},
        [`${webhookPort}/tcp`]: {},
        [`${privateWebhookPort}/tcp`]: {},
        [`${PINAI_WORKSPACE_STATUS_PORT}/tcp`]: {},
      },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        ExtraHosts: ["host.docker.internal:host-gateway"],
        PortBindings: {
          [`${config.openclaw.gatewayPort}/tcp`]: [{ HostPort: hostPort }],
          [`${webhookPort}/tcp`]: [{ HostPort: webhookHostPort }],
          [`${privateWebhookPort}/tcp`]: [{ HostPort: privateWebhookHostPort }],
          [`${PINAI_WORKSPACE_STATUS_PORT}/tcp`]: [{ HostPort: workspaceStatusHostPort }],
        },
        Binds: [
          `${dirs.baseDir}:/app`,
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
    const target = resolveDockerProbeTarget(ref, options);
    return probeGatewayReady(target, options);
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
    const mountedSource = findBindSource(binds, "/app");
    if (mountedSource !== dirs.baseDir) return true;

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
    if (!exposedPorts[`${PINAI_WORKSPACE_STATUS_PORT}/tcp`]) {
      return true;
    }

    const needsSecretEnvPrune = DOCKER_FORBIDDEN_SECRET_ENV_KEYS.some((key) =>
      hasEnvKey(inspect?.Config?.Env, key),
    );
    if (needsSecretEnvPrune) return true;

    // Write updated config and check if restart is needed
    const liteLlmApiKey = params.liteLlmApiKey;
    const { changed } = ensureOpenclawConfig(
      dirs.openclawDir,
      params.assistantBotId,
      params.gatewayToken,
      params.assistantBotToken,
      liteLlmApiKey,
      params.skillsConfig,
    );
    const profileChanged = ensureWorkspaceUserProfile(
      dirs.workspaceDir,
      params.onboardingProfileText,
      params.onboardingProfileSource,
    );

    sanitizeCronStore(dirs.openclawDir);

    // If config changed and container is running, orchestrator should restart
    // We return false because recreation (destroy+create) is not needed
    if (changed || profileChanged) {
      // Restart the running container to pick up config changes
      if (inspect.State?.Status === "running") {
        await container.restart();
      }
    }

    return false;
  },
};
