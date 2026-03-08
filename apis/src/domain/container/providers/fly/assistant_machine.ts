import crypto from "node:crypto";
import { getContainerManagerRuntime } from "../../runtime.js";
import type { ContainerManagerConfig } from "../../types.js";
import { config as appConfig } from "../../../common/config.js";
import { isAssistantContainerName } from "../../naming.js";
import { buildAssistantOpenclawConfig } from "../shared/openclaw_config.js";
import {
  renderUserProfileMarkdown,
  sha256Hex,
} from "../../../onboarding/profile_bootstrap.js";
import {
  assertNoP0SecretsInConfig,
  assertNoP0SecretsInEnv,
} from "../shared/secret_guard.js";
import { toOpenclawSkillsPayload } from "../../../skills/openclaw_skills.js";
import {
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
  PINAI_GOOGLE_CREDENTIALS_B64_ENV,
} from "../shared/google_workspace_credentials.js";
import { QUICKSTART_SYNTHETIC_BOT_TOKEN } from "../shared/telegram_runtime_secret.js";
import {
  buildWebhookParams,
  buildBaseContainerEnv,
} from "../shared/webhook_params.js";
import { FLY_FORBIDDEN_SECRET_ENV_KEYS } from "../shared/secret_env.js";
import {
  createMachine as createFlyMachine,
  createVolume,
  destroyVolume,
  isInsufficientResourcesError,
  isMachineNameConflict,
  isVolumeAlreadyExists,
  isVolumeNotFoundError,
  listMachines,
  listVolumes,
} from "./fly_client.js";
import type { FlyMachine, FlyVolume, UnknownRecord } from "./types.js";

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) =>
    getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig],
});

const FLY_DEPLOY_SYNC_CACHE_TTL_MS = 30_000;
const FLY_VOLUME_WAIT_TIMEOUT_MS = 45_000;
const FLY_CREATE_RETRIES = 8;

interface AssistantMachineCreateArgs {
  assistantBotId: number;
  machineName: string;
  gatewayToken: string;
  assistantBotToken?: string | null;
  liteLlmApiKey: string | null;
  onboardingProfileText?: string | null;
  onboardingProfileSource?: "connector" | "privy" | null;
  skillsConfig?: UnknownRecord | null;
}

let latestAppDeployCache: {
  updatedAtMs: number | null;
  expiresAt: number;
} | null = null;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isAssistantMachineName = (name: string | undefined): boolean =>
  isAssistantContainerName(name);

const toTimestampMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeAssistantToken = (value: string | null | undefined): string =>
  (value || "").trim();

const extractOrigin = (urlStr: string): string => {
  try {
    const u = new URL(urlStr);
    return u.origin;
  } catch {
    return urlStr;
  }
};

const hashConfigSha256 = (raw: string): string =>
  crypto.createHash("sha256").update(raw).digest("hex");

const buildOnboardingProfilePayload = (
  profileText?: string | null,
  profileSource?: "connector" | "privy" | null,
): { markdown: string; base64: string; hash: string } | null => {
  const normalized = (profileText || "").trim();
  if (!normalized) return null;
  const markdown = renderUserProfileMarkdown(
    normalized,
    profileSource || "connector",
  );
  return {
    markdown,
    base64: Buffer.from(markdown, "utf8").toString("base64"),
    hash: sha256Hex(markdown),
  };
};

const buildAssistantOpenclawConfigPayload = (
  assistantBotId: number,
  gatewayToken: string,
  assistantBotToken: string,
  liteLlmApiKey: string | null,
  skillsConfig?: UnknownRecord | null,
): { config: UnknownRecord; json: string; base64: string; hash: string } => {
  const wp = buildWebhookParams(
    config,
    assistantBotId,
    gatewayToken,
    appConfig.apiAuthToken,
    "loopback",
  );
  if (!wp.webhookUrl) {
    throw new Error(
      "telegramRouter.webhookUrl is required to keep OpenClaw in webhook mode",
    );
  }
  const openclawConfigContext = {
    openclaw: config.openclaw,
    elevenLabs: config.elevenLabs,
    litellm: config.litellm,
  };

  const built = buildAssistantOpenclawConfig(openclawConfigContext, {
    gatewayToken,
    gatewayBind: "loopback",
    assistantBotToken,
    quickStartSyntheticBotToken: QUICKSTART_SYNTHETIC_BOT_TOKEN,
    liteLlmApiKey,
    includeTelegramPlugin: true,
    telegramWebhookMode: true,
    telegramWebhookPort: wp.webhookPort,
    telegramPrivateWebhookPort: wp.privateWebhookPort,
    telegramWebhookUrl: wp.webhookUrl,
    telegramWebhookSecret: wp.webhookSecret,
    ...(wp.webhookPath ? { telegramWebhookPath: wp.webhookPath } : {}),
    ...(wp.webhookHost ? { telegramWebhookHost: wp.webhookHost } : {}),
    ...(wp.pluginPath ? { telegramRouterPluginPath: wp.pluginPath } : {}),
    controlOrigin: appConfig.publicBaseUrl,
    ...(skillsConfig
      ? { skillsConfig: toOpenclawSkillsPayload(skillsConfig) }
      : {}),
  });
  assertNoP0SecretsInConfig(built, config);
  const json = JSON.stringify(built);
  return {
    config: built,
    json,
    base64: Buffer.from(json, "utf8").toString("base64"),
    hash: hashConfigSha256(json),
  };
};

const sanitizeVolumePrefix = (value: string): string => {
  return value.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
};

const buildAssistantVolumeName = (assistantBotId: number): string => {
  const rawPrefix = (
    config.fly.volumeNamePrefix || "pinclaw_assistant"
  ).toLowerCase();
  const sanitizedPrefix =
    sanitizeVolumePrefix(rawPrefix) || "pinclaw_assistant";
  const suffix = String(assistantBotId).replace(/[^0-9]/g, "") || "0";
  const maxPrefixLength = Math.max(1, 30 - suffix.length - 1);
  const prefix =
    sanitizedPrefix.slice(0, maxPrefixLength).replace(/^_+|_+$/g, "") || "a";
  return `${prefix}_${suffix}`.slice(0, 30);
};

const isVolumeReady = (volume: FlyVolume): boolean => {
  const state = (volume.state || "").toLowerCase();
  if (!state) return true;
  return state === "created" || state === "ready";
};

const selectPreferredVolume = (
  name: string,
  volumes: FlyVolume[],
): FlyVolume | null => {
  const candidates = volumes.filter((item) => item.name === name);
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aAttached = a.attached_machine_id ? 1 : 0;
    const bAttached = b.attached_machine_id ? 1 : 0;
    if (aAttached !== bAttached) return bAttached - aAttached;

    const aCreatedAt = toTimestampMs(a.created_at) ?? 0;
    const bCreatedAt = toTimestampMs(b.created_at) ?? 0;
    if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt;
    return b.id.localeCompare(a.id);
  });

  return candidates[0] ?? null;
};

const waitForVolumeReady = async (
  name: string,
  expectedId?: string,
): Promise<FlyVolume | null> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < FLY_VOLUME_WAIT_TIMEOUT_MS) {
    const volumes = await listVolumes();
    const existing = selectPreferredVolume(name, volumes);
    if (
      existing &&
      (!expectedId || existing.id === expectedId) &&
      isVolumeReady(existing)
    ) {
      return existing;
    }
    await sleep(1000);
  }
  return null;
};

const ensureAssistantVolume = async (
  assistantBotId: number,
  region?: string,
): Promise<{ volume: FlyVolume; created: boolean }> => {
  const name = buildAssistantVolumeName(assistantBotId);
  const targetRegion = (region ?? config.fly.region).toLowerCase();

  const volumes = await listVolumes();
  const sameRegion = targetRegion
    ? volumes.filter((v) => (v.region ?? "").toLowerCase() === targetRegion)
    : volumes;
  const existing = selectPreferredVolume(
    name,
    sameRegion.length ? sameRegion : volumes,
  );
  if (existing && isVolumeReady(existing))
    return { volume: existing, created: false };

  if (existing?.id) {
    const existingReady = await waitForVolumeReady(name, existing.id);
    if (existingReady) return { volume: existingReady, created: false };
  }

  let created: FlyVolume | null = null;
  try {
    created = await createVolume(name, targetRegion);
  } catch (error: unknown) {
    if (!isVolumeAlreadyExists(error)) {
      throw error;
    }
  }

  if (created && isVolumeReady(created))
    return { volume: created, created: true };

  const readyAfterCreate = await waitForVolumeReady(name, created?.id);
  if (readyAfterCreate) return { volume: readyAfterCreate, created: true };

  const fallbackVolumes = await listVolumes();
  const fallback = selectPreferredVolume(name, fallbackVolumes);
  if (fallback) return { volume: fallback, created: false };

  if (created) return { volume: created, created: true };
  throw new Error(`Fly volume ${name} is not ready`);
};

export const getLatestAppDeployTimestampMs = async (): Promise<
  number | null
> => {
  const now = Date.now();
  if (latestAppDeployCache && latestAppDeployCache.expiresAt > now) {
    return latestAppDeployCache.updatedAtMs;
  }

  const machines = await listMachines();
  let latest: number | null = null;

  machines.forEach((machine) => {
    if (isAssistantMachineName(machine.name)) return;
    const machineUpdatedAtMs =
      toTimestampMs(machine.updated_at) ?? toTimestampMs(machine.created_at);
    if (machineUpdatedAtMs === null) return;
    if (latest === null || machineUpdatedAtMs > latest) {
      latest = machineUpdatedAtMs;
    }
  });

  latestAppDeployCache = {
    updatedAtMs: latest,
    expiresAt: now + FLY_DEPLOY_SYNC_CACHE_TTL_MS,
  };

  return latest;
};

export const shouldRecreateAssistantMachine = (
  machine: FlyMachine,
  latestAppDeployAtMs: number | null,
  desiredGatewayToken: string,
  desiredAssistantBotToken?: string | null,
  desiredLiteLLMApiKey?: string | null,
  desiredOnboardingProfileText?: string | null,
  desiredOnboardingProfileSource?: "connector" | "privy" | null,
  desiredSkillsConfig?: UnknownRecord | null,
): boolean => {
  const configuredImage = machine.config?.image?.trim();
  if (configuredImage && configuredImage !== config.openclaw.image) {
    return true;
  }

  const configuredMemoryMb = machine.config?.guest?.memory_mb;
  if (
    typeof configuredMemoryMb === "number" &&
    configuredMemoryMb !== config.container.memoryMb
  ) {
    return true;
  }

  const configuredCpus = machine.config?.guest?.cpus;
  if (
    typeof configuredCpus === "number" &&
    configuredCpus !== Math.max(1, config.fly.machineCpus)
  ) {
    return true;
  }

  const desiredToken = normalizeAssistantToken(desiredAssistantBotToken);
  const desiredConfigHash = buildAssistantOpenclawConfigPayload(
    Number(machine.name?.replace(/^assistant-/, "") || 0),
    desiredGatewayToken,
    desiredToken,
    desiredLiteLLMApiKey || null,
    desiredSkillsConfig,
  ).hash;

  const currentEnv = machine.config?.env;
  const currentConfigHash = currentEnv?.PINAI_OPENCLAW_CONFIG_SHA256;
  if (
    typeof currentConfigHash !== "string" ||
    currentConfigHash.trim() !== desiredConfigHash
  ) {
    return true;
  }

  const desiredProfile = buildOnboardingProfilePayload(
    desiredOnboardingProfileText,
    desiredOnboardingProfileSource,
  );
  const desiredProfileHash = desiredProfile?.hash || "";
  const currentProfileHash = (
    currentEnv?.PINAI_ONBOARDING_PROFILE_SHA256 || ""
  ).trim();
  if (currentProfileHash !== desiredProfileHash) {
    return true;
  }

  if (currentEnv?.TELEGRAM_BOT_TOKEN) {
    return true;
  }

  if (currentEnv) {
    const hasSecretEnv = FLY_FORBIDDEN_SECRET_ENV_KEYS.some((key) => {
      const value = currentEnv[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (hasSecretEnv) {
      return true;
    }
  }

  if (currentEnv?.OPENCLAW_HOME !== "/app") {
    return true;
  }

  const initExec = machine.config?.init?.exec;
  if (!Array.isArray(initExec) || initExec.length === 0) return false;

  const joined = initExec.join(" ");
  if (!joined.includes("pinai-entrypoint.sh")) return true;

  if (latestAppDeployAtMs === null) return false;

  const machineUpdatedAtMs =
    toTimestampMs(machine.updated_at) ?? toTimestampMs(machine.created_at);
  if (machineUpdatedAtMs === null) return false;

  return machineUpdatedAtMs < latestAppDeployAtMs;
};

export const createAssistantMachine = async (
  args: AssistantMachineCreateArgs,
): Promise<FlyMachine> => {
  const normalizedAssistantBotToken = normalizeAssistantToken(
    args.assistantBotToken,
  );
  const normalizedWebhookPort = config.telegramRouter.webhookPort;
  const normalizedPrivateWebhookPort = normalizedWebhookPort + 1;
  const openclawPayload = buildAssistantOpenclawConfigPayload(
    args.assistantBotId,
    args.gatewayToken,
    normalizedAssistantBotToken,
    args.liteLlmApiKey,
    args.skillsConfig,
  );
  const onboardingProfile = buildOnboardingProfilePayload(
    args.onboardingProfileText,
    args.onboardingProfileSource,
  );

  const routerOrigin = config.telegramRouter.webhookUrl
    ? extractOrigin(config.telegramRouter.webhookUrl)
    : extractOrigin(appConfig.publicBaseUrl);
  const env: Record<string, string> = {
    ...buildBaseContainerEnv(
      config,
      args.assistantBotId,
      normalizedWebhookPort,
      normalizedPrivateWebhookPort,
      routerOrigin,
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
    ),
    OPENCLAW_CONFIG_B64: openclawPayload.base64,
    PINAI_OPENCLAW_CONFIG_SHA256: openclawPayload.hash,
    PINAI_ONBOARDING_PROFILE_B64: onboardingProfile?.base64 || "",
    PINAI_ONBOARDING_PROFILE_SHA256: onboardingProfile?.hash || "",
    PINAI_ONBOARDING_HAS_PROFILE: onboardingProfile ? "1" : "0",
    [PINAI_GOOGLE_CREDENTIALS_B64_ENV]: "",
    PINAI_FLY_MODE: "1",
    PINAI_GATEWAY_BIND: "loopback",
  };
  assertNoP0SecretsInEnv(env, config);

  // All bootstrap logic (secret decode, cache seed, workspace init,
  // IPv6 proxies) is handled by pinai-entrypoint.sh baked into the image.
  // The entrypoint reads from the env vars set above.
  const bootstrapCommand = "exec pinai-entrypoint.sh";

  const regions = config.fly.regionFallbacks?.length
    ? config.fly.regionFallbacks
    : [config.fly.region];
  let lastError: unknown = null;

  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex];
    for (let attempt = 1; attempt <= FLY_CREATE_RETRIES; attempt += 1) {
      const { volume, created } = await ensureAssistantVolume(
        args.assistantBotId,
        region,
      );

      try {
        const machineBody = {
          name: args.machineName,
          region: volume.region ?? region,
          config: {
            image: config.openclaw.image,
            env,
            guest: {
              cpu_kind: "shared",
              cpus: Math.max(1, config.fly.machineCpus),
              memory_mb: config.container.memoryMb,
            },
            mounts: [{ volume: volume.id, path: "/app" }],
            restart: {
              policy: "on-failure",
              max_retries: 3,
            },
            init: {
              exec: ["sh", "-lc", bootstrapCommand],
            },
          },
        };
        return await createFlyMachine(machineBody);
      } catch (error: unknown) {
        lastError = error;

        if (isMachineNameConflict(error)) {
          const machines = await listMachines();
          const existing = machines.find(
            (machine) => machine.name === args.machineName,
          );
          if (existing) return existing;
        }

        if (isInsufficientResourcesError(error)) {
          if (created && regionIndex < regions.length - 1) {
            try {
              await destroyVolume(volume.id);
            } catch {
              /* ignore */
            }
            console.warn(
              `Fly region ${region} insufficient resources, trying next: ${regions[regionIndex + 1]}`,
            );
            break;
          }
          if (attempt < FLY_CREATE_RETRIES) {
            await sleep(1000 * attempt);
            continue;
          }
        }

        if (!isVolumeNotFoundError(error) || attempt >= FLY_CREATE_RETRIES) {
          throw error;
        }

        await sleep(1000 * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Fly machine creation failed");
};
