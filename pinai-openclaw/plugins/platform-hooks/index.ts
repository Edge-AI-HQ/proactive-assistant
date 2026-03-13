// OpenClaw Plugin: PinAI Platform Hooks
// Handles platform-level integrations:
// 1. System prompt injection — injects platform guidance (API proxy rules,
//    reminder policy) via before_prompt_build hook.
// 2. Cron delivery auto-completion — patches cron.add tool calls to fill in
//    missing delivery targets (accountId, to) inferred from sessionKey,
//    using the before_tool_call hook.
// 3. Device auto-pairing — pre-creates Ed25519 device identity and writes
//    paired.json at startup, then polls for new pairing requests via
//    registerService for proper lifecycle management.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const SYSTEM_GUIDANCE_PATH =
  process.env.PINAI_SYSTEM_GUIDANCE_PATH || "/opt/pinai/platform-system-guidance.md";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferAccountIdFromSessionKey(sessionKey: string): string | null {
  const raw = (sessionKey || "").trim().toLowerCase();
  if (raw === "agent:main:main") return "private";
  if (/^telegram:\d+$/.test(raw)) return "private";
  if (!raw.startsWith("agent:")) return null;

  const parts = raw.split(":").filter(Boolean);
  const rest = parts.slice(2);
  if (rest.length < 3) return null;

  const markerIndex = rest.findIndex(
    (part) => part === "direct" || part === "dm" || part === "group" || part === "channel",
  );
  if (markerIndex <= 0) return null;

  const segment = rest.slice(0, markerIndex);
  const candidate = segment[segment.length - 1]?.trim();
  if (!candidate) return null;
  if (candidate === "public") return "default";
  if (candidate === "default" || candidate === "private") return candidate;
  return null;
}

function inferPeerIdFromSessionKey(sessionKey: string): string | null {
  const raw = (sessionKey || "").trim().toLowerCase();
  const tgMatch = raw.match(/^telegram:(\d+)$/);
  if (tgMatch?.[1]) return tgMatch[1];
  if (!raw.startsWith("agent:")) return null;

  const parts = raw.split(":").filter(Boolean);
  const markerIndex = parts.findIndex(
    (part) => part === "direct" || part === "dm" || part === "group" || part === "channel",
  );
  if (markerIndex < 0 || markerIndex + 1 >= parts.length) return null;
  const candidate = parts[markerIndex + 1]?.trim() || "";
  return /^\d+$/.test(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Cron delivery auto-completion via before_tool_call hook
// ---------------------------------------------------------------------------

function installCronDeliveryHook(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "cron") return;

    const params = event.params as Record<string, unknown> | undefined;
    if (!params || params.action !== "add") return;

    // Handle both flat params and nested job form
    const job = isRecord(params.job) ? (params.job as Record<string, unknown>) : params;
    const delivery = isRecord(job.delivery) ? { ...(job.delivery as Record<string, unknown>) } : {};
    const mode = typeof delivery.mode === "string" ? delivery.mode.trim().toLowerCase() : "";
    if (mode === "none" || mode === "webhook") return;

    // Get sessionKey: prefer hook context, fall back to tool params
    const sessionKey =
      (typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "") ||
      (typeof job.sessionKey === "string" ? job.sessionKey : "") ||
      (isRecord(job.payload) && typeof job.payload.sessionKey === "string"
        ? job.payload.sessionKey
        : "");

    const inferredAccountId = inferAccountIdFromSessionKey(sessionKey);
    const inferredPeerId = inferPeerIdFromSessionKey(sessionKey);

    const existingTo = typeof delivery.to === "string" ? delivery.to.trim() : "";
    const existingAccountId =
      typeof delivery.accountId === "string" && delivery.accountId.trim()
        ? (delivery.accountId as string).trim().toLowerCase()
        : "";

    const hasInferredTarget = inferredAccountId || inferredPeerId;
    const hasExistingTarget = existingTo || existingAccountId;

    if (!hasInferredTarget && !hasExistingTarget) {
      api.logger.info('[cron.add hook] No target info, using "last" channel to bypass pairing');
      const patchedDelivery = { ...delivery, mode: "announce", channel: "last", accountId: "default" };
      // Return params for shallow merge with original params
      return isRecord(params.job)
        ? { params: { job: { ...job, delivery: patchedDelivery } } }
        : { params: { delivery: patchedDelivery } };
    }

    const inferredTo = inferredPeerId ? `telegram:${inferredPeerId}` : "";
    const nextTo = inferredTo || existingTo;
    const nextMode = typeof delivery.mode === "string" && delivery.mode.trim() ? delivery.mode : "announce";
    const nextChannel =
      typeof delivery.channel === "string" && delivery.channel.trim() ? delivery.channel : "telegram";
    const nextAccountId = inferredAccountId || existingAccountId || undefined;

    const patchedDelivery = {
      ...delivery,
      mode: nextMode,
      channel: nextChannel,
      ...(nextTo ? { to: nextTo } : {}),
      ...(nextAccountId ? { accountId: nextAccountId } : {}),
    };

    api.logger.info(
      `[cron.add hook] sessionKey=${sessionKey || "n/a"} accountId=${nextAccountId || "n/a"} to=${nextTo || "n/a"}`,
    );

    return isRecord(params.job)
      ? { params: { job: { ...job, delivery: patchedDelivery } } }
      : { params: { delivery: patchedDelivery } };
  });

  api.logger.info("[cron.add] before_tool_call hook registered");
}

// ---------------------------------------------------------------------------
// Device auto-pairing
// ---------------------------------------------------------------------------

async function prePairDeviceIdentity(api: OpenClawPluginApi) {
  try {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ||
      `${process.env.OPENCLAW_HOME || process.env.HOME || "/app"}/.openclaw`;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const crypto = await import("node:crypto");

    const identityDir = path.join(stateDir, "identity");
    const identityPath = path.join(identityDir, "device.json");

    let deviceId: string;
    let publicKeyPem: string;

    if (fs.existsSync(identityPath)) {
      const existing = JSON.parse(fs.readFileSync(identityPath, "utf8")) as {
        deviceId?: string;
        publicKeyPem?: string;
      };
      if (existing.deviceId && existing.publicKeyPem) {
        deviceId = existing.deviceId;
        publicKeyPem = existing.publicKeyPem;
        api.logger.info(`[auto-pairing] Existing identity ${deviceId.slice(0, 12)}…`);
      } else {
        api.logger.warn("[auto-pairing] Identity file malformed — regenerating");
        fs.unlinkSync(identityPath);
        return;
      }
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

      const ED25519_SPKI_PREFIX_LEN = 12;
      const spkiDer = publicKey.export({ type: "spki", format: "der" });
      const rawPubKey = (spkiDer as Buffer).subarray(ED25519_SPKI_PREFIX_LEN);
      deviceId = crypto.createHash("sha256").update(rawPubKey).digest("hex");

      fs.mkdirSync(identityDir, { recursive: true });
      fs.writeFileSync(
        identityPath,
        JSON.stringify({
          version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now(),
        }, null, 2) + "\n",
        { mode: 0o600 },
      );
      api.logger.info(`[auto-pairing] Created identity ${deviceId.slice(0, 12)}…`);
    }

    // Ensure device is paired
    const devicesDir = path.join(stateDir, "devices");
    fs.mkdirSync(devicesDir, { recursive: true });
    const pairedPath = path.join(devicesDir, "paired.json");
    const existingPaired: Record<string, unknown> = fs.existsSync(pairedPath)
      ? (JSON.parse(fs.readFileSync(pairedPath, "utf8")) as Record<string, unknown>)
      : {};

    if (existingPaired[deviceId]) {
      api.logger.info(`[auto-pairing] Device ${deviceId.slice(0, 12)}… already paired`);
      return;
    }

    const pubKey = crypto.createPublicKey(publicKeyPem);
    const spki = pubKey.export({ type: "spki", format: "der" });
    const rawKey = (spki as Buffer).subarray(12);
    const pubKeyB64 = rawKey
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const now = Date.now();
    existingPaired[deviceId] = {
      deviceId,
      publicKey: pubKeyB64,
      clientId: "gateway-client",
      clientMode: "backend",
      role: "admin",
      roles: ["admin", "operator"],
      scopes: [
        "operator.read", "operator.write", "operator.admin",
        "operator.approvals", "operator.pairing",
      ],
      approvedScopes: [
        "operator.read", "operator.write", "operator.admin",
        "operator.approvals", "operator.pairing",
      ],
      createdAtMs: now,
      approvedAtMs: now,
    };

    fs.writeFileSync(pairedPath, JSON.stringify(existingPaired, null, 2) + "\n");
    api.logger.info(`[auto-pairing] Pre-paired ${deviceId.slice(0, 12)}… with full scopes`);
  } catch (err) {
    api.logger.warn(`[auto-pairing] Pre-pair failed: ${String(err)}`);
  }
}

function installAutoPairingService(api: OpenClawPluginApi) {
  const CHECK_INTERVAL_MS = 3000;

  // Phase 1: Pre-pair identity at startup (must run before gateway is ready)
  prePairDeviceIdentity(api).catch(() => {});

  // Phase 2: Background polling via registerService for proper lifecycle
  // @ts-ignore — module available at runtime inside OpenClaw container
  type DevicePairSdk = typeof import("openclaw/plugin-sdk/device-pair");

  let sdk: DevicePairSdk | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  const checkAndApprovePending = async (logger: { info: Function; warn: Function }) => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!sdk) {
        try {
          // @ts-ignore — module available at runtime inside OpenClaw container
          sdk = (await import("openclaw/plugin-sdk/device-pair")) as DevicePairSdk;
        } catch { return; }
      }
      const { pending } = await sdk.listDevicePairing();
      for (const request of pending) {
        if (!("requestId" in request)) continue;
        const req = request as { requestId: string; clientId?: string };
        logger.info(`[auto-pairing] Approving: ${req.requestId}`);
        try {
          await sdk.approveDevicePairing(req.requestId);
          logger.info(`[auto-pairing] Approved: ${req.requestId}`);
        } catch (err) {
          logger.warn(`[auto-pairing] Failed: ${req.requestId}: ${String(err)}`);
        }
      }
    } catch {
      // Gateway might not be ready yet
    } finally {
      isRunning = false;
    }
  };

  api.registerService({
    id: "device-auto-pairing",
    async start(ctx: any) {
      ctx.logger.info("[auto-pairing] Service started (eager pre-pair + background polling)");
      // Initial check after 2s
      setTimeout(() => checkAndApprovePending(ctx.logger), 2000);
      // Regular polling
      timer = setInterval(() => checkAndApprovePending(ctx.logger), CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      api.logger.info("[auto-pairing] Service stopped");
    },
  });
}

// ---------------------------------------------------------------------------
// System prompt injection via before_prompt_build hook
// ---------------------------------------------------------------------------

let cachedGuidance: string | null = null;
let cachedOnboardingProfile: string | null = null;

function loadSystemGuidance(api: OpenClawPluginApi): string {
  if (cachedGuidance !== null) return cachedGuidance;
  try {
    const fs = require("fs") as typeof import("fs");
    cachedGuidance = fs.readFileSync(SYSTEM_GUIDANCE_PATH, "utf8").trim();
    api.logger.info(`[system-guidance] Loaded from ${SYSTEM_GUIDANCE_PATH} (${cachedGuidance.length} chars)`);
  } catch {
    cachedGuidance = "";
    api.logger.warn(`[system-guidance] Not found: ${SYSTEM_GUIDANCE_PATH}`);
  }
  return cachedGuidance;
}

function loadOnboardingProfile(api: OpenClawPluginApi): string {
  if (cachedOnboardingProfile !== null) return cachedOnboardingProfile;
  const b64 = process.env.PINAI_ONBOARDING_PROFILE_B64 || "";
  if (!b64.trim()) {
    cachedOnboardingProfile = "";
    return cachedOnboardingProfile;
  }
  try {
    cachedOnboardingProfile = Buffer.from(b64, "base64").toString("utf8").trim();
    api.logger.info(`[onboarding-profile] Decoded (${cachedOnboardingProfile.length} chars)`);
  } catch {
    cachedOnboardingProfile = "";
    api.logger.warn("[onboarding-profile] Failed to decode PINAI_ONBOARDING_PROFILE_B64");
  }
  return cachedOnboardingProfile;
}

function installSystemGuidanceHook(api: OpenClawPluginApi) {
  const guidance = loadSystemGuidance(api);
  const profile = loadOnboardingProfile(api);
  if (!guidance && !profile) return;

  api.on("before_prompt_build", async () => ({
    ...(guidance ? { appendSystemContext: guidance } : {}),
    ...(profile ? { prependSystemContext: profile } : {}),
  }));
  api.logger.info(
    `[system-guidance] before_prompt_build hook registered (guidance=${!!guidance}, profile=${!!profile})`,
  );
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const plugin = {
  id: "platform-hooks",
  name: "PinAI Platform Hooks",
  description: "Platform system guidance, cron delivery auto-completion, and device auto-pairing",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.logger.info("PinAI Platform Hooks enabled");
    installSystemGuidanceHook(api);
    installCronDeliveryHook(api);
    installAutoPairingService(api);
  },
};

export default plugin;
