import crypto from "node:crypto";
import { getContainerManagerRuntime } from "../../runtime.js";
import type { ContainerManagerConfig } from "../../types.js";
import { isAssistantContainerName } from "../../naming.js";
import { buildAssistantOpenclawConfig } from "../shared/openclaw_config.js";
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

const quoteForShell = (value: string): string =>
  `'${value.replace(/'/g, `"'"'`)}'`;

const resolveLiteLLMContainerBaseUrlForFly = (): string => {
  const containerBaseUrl = config.litellm.containerBaseUrl.trim();
  const liteLlmBaseUrl = config.litellm.baseUrl.trim();
  if (!containerBaseUrl) return liteLlmBaseUrl;

  const normalized = containerBaseUrl.toLowerCase();
  const pointsToLocalBridge =
    normalized.includes("host.docker.internal") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes("localhost");

  if (!pointsToLocalBridge) return containerBaseUrl;
  return liteLlmBaseUrl || containerBaseUrl;
};

const buildAssistantOpenclawConfigPayload = (
  gatewayToken: string,
  assistantBotToken: string,
  liteLlmApiKey: string | null,
): { config: UnknownRecord; json: string; hash: string } => {
  const { webhookUrl, webhookPath, webhookHost, webhookPort, pluginPath } =
    config.telegramRouter;
  const normalizedWebhookUrl = webhookUrl.trim();
  if (!normalizedWebhookUrl) {
    throw new Error(
      "telegramRouter.webhookUrl is required to keep OpenClaw in webhook mode",
    );
  }
  const privateWebhookPort = webhookPort + 1;
  const webhookSecret = config.telegram.webhookSecret;
  const openclawConfigContext = {
    openclaw: config.openclaw,
    elevenLabs: config.elevenLabs,
    litellm: {
      ...config.litellm,
      containerBaseUrl: resolveLiteLLMContainerBaseUrlForFly(),
    },
  };

  const built = buildAssistantOpenclawConfig(openclawConfigContext, {
    gatewayToken,
    gatewayBind: "loopback",
    assistantBotToken,
    publicBotToken: config.telegram.token,
    liteLlmApiKey,
    includeTelegramPlugin: true,
    telegramWebhookMode: true,
    telegramWebhookPort: webhookPort,
    telegramPrivateWebhookPort: privateWebhookPort,
    telegramWebhookUrl: normalizedWebhookUrl,
    ...(webhookSecret ? { telegramWebhookSecret: webhookSecret } : {}),
    ...(webhookPath ? { telegramWebhookPath: webhookPath } : {}),
    ...(webhookHost ? { telegramWebhookHost: webhookHost } : {}),
    ...(pluginPath ? { telegramRouterPluginPath: pluginPath } : {}),
  });
  const json = JSON.stringify(built);
  return {
    config: built,
    json,
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
    desiredGatewayToken,
    desiredToken,
    desiredLiteLLMApiKey || null,
  ).hash;

  const currentEnv = machine.config?.env;
  const currentConfigHash = currentEnv?.PINAI_OPENCLAW_CONFIG_SHA256;
  if (
    typeof currentConfigHash !== "string" ||
    currentConfigHash.trim() !== desiredConfigHash
  ) {
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

  if (currentEnv?.OPENCLAW_CONFIG_PATH !== "/app/data/config/openclaw.json") {
    return true;
  }

  const initExec = machine.config?.init?.exec;
  if (!Array.isArray(initExec) || initExec.length === 0) return false;

  const joined = initExec.join(" ");
  const legacyConfig =
    !joined.includes("[fly-ipv6-proxy]") ||
    !joined.includes("[fly-tg-webhook-ipv6-proxy]") ||
    !joined.includes("openclaw gateway --bind loopback");
  if (legacyConfig) return true;

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
    args.gatewayToken,
    normalizedAssistantBotToken,
    args.liteLlmApiKey,
  );

  const vncPort = 8444;
  const vncProxyPort = 8445; // IPv6 代理使用不同端口避免冲突
  const apisInternalPort = Number.parseInt(process.env.PORT || "3000", 10);
  const routerOrigin = config.telegramRouter.webhookUrl
    ? extractOrigin(config.telegramRouter.webhookUrl)
    : `http://${config.fly.appName}.internal:${apisInternalPort}`;
  const env: Record<string, string> = {
    OPENCLAW_USER_ID: `assistant-${args.assistantBotId}`,
    OPENCLAW_GATEWAY_PORT: String(config.openclaw.gatewayPort),
    OPENCLAW_TELEGRAM_WEBHOOK_PORT: String(normalizedWebhookPort),
    OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT: String(
      normalizedPrivateWebhookPort,
    ),
    OPENCLAW_CONFIG_PATH: "/app/data/config/openclaw.json",
    OPENCLAW_STATE_DIR: "/app/data",
    NODE_COMPILE_CACHE: "/app/data/cache/node-compile-cache",
    PINAI_OPENCLAW_CONFIG_SHA256: openclawPayload.hash,
    VNC_PORT: String(vncPort),
    VNC_PROXY_PORT: String(vncProxyPort),
    DISPLAY: ":1",
    // Playwright browser launch args for container environment
    PLAYWRIGHT_CHROMIUM_ARGS:
      "--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage",
    TELEGRAM_ROUTER_URL: routerOrigin,
  };

  // Persist jiti + Node compile caches on the volume so restarts skip
  // the expensive cold-compile phase (~7 min → seconds).
  const cacheBootstrap = [
    "mkdir -p /app/data/cache/jiti /app/data/cache/node-compile-cache",
    "ln -sfn /app/data/cache/jiti /tmp/jiti",
    "export NODE_COMPILE_CACHE=/app/data/cache/node-compile-cache",
  ].join(" && ");

  const reminderPolicyBootstrap = [
    "touch /app/data/workspace/AGENTS.md",
    'grep -q "PINAI_REMINDER_POLICY_V1" /app/data/workspace/AGENTS.md || printf "\\n# PINAI_REMINDER_POLICY_V1\\n- For time-based reminders and scheduled follow-ups, ALWAYS use the cron tool (cron.add / cron.update / cron.run).\\n- NEVER use exec/process with sleep, while, timeout, or background shell jobs to simulate timers.\\n- For Telegram reminders, always send back to the same channel/account context where the user asked.\\n" >> /app/data/workspace/AGENTS.md',
  ].join(" && ");

  // VNC setup: generate password, start TigerVNC in background
  // VNC 监听 localhost，IPv6 代理使用不同端口（8445）避免冲突
  // 降低分辨率和色深以减少延迟：1280x720 @ 16bit
  const vncBootstrap = `(
    mkdir -p /app/data/vnc /root/.vnc &&
    if [ ! -f /app/data/vnc/passwd ]; then echo 'pinai123' | vncpasswd -f > /app/data/vnc/passwd; chmod 600 /app/data/vnc/passwd; fi &&
    ln -sf /app/data/vnc/passwd /root/.vnc/passwd &&
    export DISPLAY=:1 &&
    printf "%s\\n" "#!/bin/sh" "unset SESSION_MANAGER" "unset DBUS_SESSION_BUS_ADDRESS" "exec startxfce4" > /root/.vnc/xstartup &&
    chmod +x /root/.vnc/xstartup &&
    vncserver :1 -geometry 1280x720 -depth 16 -rfbport ${vncPort} -localhost yes -SecurityTypes VncAuth >/tmp/tigervnc.log 2>&1 &&
    sleep 3 &&
    node -e 'const net=require("net");const vncPort=${vncPort};const proxyPort=${vncProxyPort};const server=net.createServer((inbound)=>{const outbound=net.connect({host:"127.0.0.1",port:vncPort});inbound.pipe(outbound);outbound.pipe(inbound);const close=()=>{inbound.destroy();outbound.destroy();};inbound.on("error",close);outbound.on("error",close);});server.on("error",(err)=>{console.error("[fly-vnc-ipv6-proxy] fatal",err);process.exit(1);});server.listen({host:"::",port:proxyPort,ipv6Only:true},()=>{console.log(\`[fly-vnc-ipv6-proxy] listening on [::]:$\{proxyPort} -> 127.0.0.1:$\{vncPort}\`);});'
  ) >/tmp/vnc-bootstrap.log 2>&1 &`;

  // 构建启动命令：前置准备 + 后台任务 + 主进程
  const setupCommands = [
    "mkdir -p /app/data/workspace /app/data/tmp /app/data/config /root/.openclaw",
    `printf "%s" ${quoteForShell(openclawPayload.json)} > "$OPENCLAW_CONFIG_PATH"`,
    "ln -sfn /app/data/workspace /root/.openclaw/workspace",
    reminderPolicyBootstrap,
    cacheBootstrap,
  ].join(" && ");

  const backgroundTasks = [
    // VNC 后台启动（已包含 & 结尾）
    vncBootstrap,
    // IPv6 代理们（后台进程）
    `node -e 'const net=require("net");const port=Number(process.env.OPENCLAW_GATEWAY_PORT||${config.openclaw.gatewayPort});const server=net.createServer((inbound)=>{const outbound=net.connect({host:"127.0.0.1",port});inbound.pipe(outbound);outbound.pipe(inbound);const close=()=>{inbound.destroy();outbound.destroy();};inbound.on("error",close);outbound.on("error",close);});server.on("error",(err)=>{console.error("[fly-ipv6-proxy] fatal",err);process.exit(1);});server.listen({host:"::",port,ipv6Only:true},()=>{console.log(\`[fly-ipv6-proxy] listening on [::]:\${port} -> 127.0.0.1:\${port}\`);});' >/tmp/fly-ipv6-proxy.log 2>&1 &`,
    `node -e 'const net=require("net");const port=Number(process.env.OPENCLAW_TELEGRAM_WEBHOOK_PORT||${normalizedWebhookPort});const server=net.createServer((inbound)=>{const outbound=net.connect({host:"127.0.0.1",port});inbound.pipe(outbound);outbound.pipe(inbound);const close=()=>{inbound.destroy();outbound.destroy();};inbound.on("error",close);outbound.on("error",close);});server.on("error",(err)=>{console.error("[fly-tg-webhook-ipv6-proxy] fatal",err);process.exit(1);});server.listen({host:"::",port,ipv6Only:true},()=>{console.log(\`[fly-tg-webhook-ipv6-proxy] listening on [::]:\${port} -> 127.0.0.1:\${port}\`);});' >/tmp/fly-tg-webhook-ipv6-proxy.log 2>&1 &`,
    `node -e 'const net=require("net");const port=Number(process.env.OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT||${normalizedPrivateWebhookPort});const server=net.createServer((inbound)=>{const outbound=net.connect({host:"127.0.0.1",port});inbound.pipe(outbound);outbound.pipe(inbound);const close=()=>{inbound.destroy();outbound.destroy();};inbound.on("error",close);outbound.on("error",close);});server.on("error",(err)=>{console.error("[fly-tg-private-webhook-ipv6-proxy] fatal",err);process.exit(1);});server.listen({host:"::",port,ipv6Only:true},()=>{console.log(\`[fly-tg-private-webhook-ipv6-proxy] listening on [::]:\${port} -> 127.0.0.1:\${port}\`);});' >/tmp/fly-tg-private-webhook-ipv6-proxy.log 2>&1 &`,
    "sleep 0.2",
  ].join(" ");

  const bootstrapCommand = `${setupCommands} && ${backgroundTasks} && exec openclaw gateway --bind loopback`;

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
            mounts: [{ volume: volume.id, path: "/app/data" }],
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
