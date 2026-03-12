// OpenClaw Plugin: PinAI Platform Hooks
// Handles platform-level integrations:
// 1. System prompt injection — injects platform guidance (API proxy rules,
//    reminder policy) via before_prompt_build hook.
// 2. Cron delivery auto-completion — patches cron.add RPC calls to fill in
//    missing delivery targets (accountId, to) inferred from sessionKey.
// 3. Device auto-pairing — pre-creates Ed25519 device identity and writes
//    paired.json at startup, then polls for new pairing requests.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const FETCH_PATCH_KEY = "__pinaiPlatformHooksPatched__";
const OPENCLAW_GATEWAY_PORT = Number.parseInt(
  process.env.OPENCLAW_GATEWAY_PORT || "18789",
  10,
);
const SYSTEM_GUIDANCE_PATH =
  process.env.PINAI_SYSTEM_GUIDANCE_PATH || "/opt/pinai/platform-system-guidance.md";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenClawGatewayRpc(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) return false;
  const port = Number.parseInt(url.port || "", 10);
  if (!Number.isFinite(port) || port !== OPENCLAW_GATEWAY_PORT) return false;
  return url.pathname === "/rpc" || url.pathname === "/gateway" || url.pathname === "/gateway/rpc";
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
// Cron delivery patch
// ---------------------------------------------------------------------------

async function patchCronAddDeliveryAccountId(
  input: RequestInfo | URL,
  init?: RequestInit,
  api?: OpenClawPluginApi,
): Promise<RequestInit | null> {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : "";
  if (!rawUrl) return null;

  let targetUrl: URL;
  try { targetUrl = new URL(rawUrl); } catch { return null; }
  if (!isOpenClawGatewayRpc(targetUrl)) return null;

  const method = (
    init?.method || (input instanceof Request ? input.method : "GET")
  ).trim().toUpperCase();
  if (method !== "POST") return null;

  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  const contentType = headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) return null;

  let bodyText = "";
  const rawBody = init?.body;
  if (typeof rawBody === "string") {
    bodyText = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(rawBody);
  } else if (input instanceof Request) {
    try { bodyText = await input.clone().text(); } catch { bodyText = ""; }
  }
  if (!bodyText) return null;

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(bodyText) as Record<string, unknown>; } catch { return null; }
  if (parsed.method !== "cron.add" || !isRecord(parsed.params)) return null;

  const job = parsed.params;
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const mode = typeof delivery.mode === "string" ? delivery.mode.trim().toLowerCase() : "";
  if (mode === "none" || mode === "webhook") return null;

  const sessionKey =
    typeof job.sessionKey === "string"
      ? job.sessionKey
      : isRecord(job.payload) && typeof job.payload.sessionKey === "string"
        ? job.payload.sessionKey
        : "";
  const inferredAccountId = inferAccountIdFromSessionKey(sessionKey);
  const inferredPeerId = inferPeerIdFromSessionKey(sessionKey);

  const existingTo = typeof delivery.to === "string" ? delivery.to.trim() : "";
  const existingAccountId =
    typeof delivery.accountId === "string" && delivery.accountId.trim()
      ? delivery.accountId.trim().toLowerCase()
      : "";

  const hasInferredTarget = inferredAccountId || inferredPeerId;
  const hasExistingTarget = existingTo || existingAccountId;

  if (!hasInferredTarget && !hasExistingTarget) {
    api?.logger.info('[cron.add patch] No target info, using "last" channel to bypass pairing');
    parsed.params = {
      ...job,
      delivery: { ...delivery, mode: "announce", channel: "last", accountId: "default" },
    };
    return {
      ...(input instanceof Request
        ? { method: input.method, redirect: input.redirect, credentials: input.credentials }
        : {}),
      ...init,
      headers,
      body: JSON.stringify(parsed),
    };
  }

  const inferredTo = inferredPeerId ? `telegram:${inferredPeerId}` : "";
  const nextTo = inferredTo || existingTo;
  const nextMode = typeof delivery.mode === "string" && delivery.mode.trim() ? delivery.mode : "announce";
  const nextChannel = typeof delivery.channel === "string" && delivery.channel.trim() ? delivery.channel : "telegram";
  const nextAccountId = inferredAccountId || existingAccountId || undefined;

  parsed.params = {
    ...job,
    delivery: {
      ...delivery,
      mode: nextMode,
      channel: nextChannel,
      ...(nextTo ? { to: nextTo } : {}),
      ...(nextAccountId ? { accountId: nextAccountId } : {}),
    },
  };
  api?.logger.info(
    `[cron.add patch] sessionKey=${sessionKey || "n/a"} accountId=${nextAccountId || "n/a"} to=${nextTo || "n/a"}`,
  );

  return {
    ...(input instanceof Request
      ? { method: input.method, redirect: input.redirect, credentials: input.credentials }
      : {}),
    ...init,
    headers,
    body: JSON.stringify(parsed),
  };
}

// ---------------------------------------------------------------------------
// Fetch proxy installation (cron delivery only)
// ---------------------------------------------------------------------------

function installFetchProxy(api: OpenClawPluginApi) {
  const g = globalThis as typeof globalThis & { [FETCH_PATCH_KEY]?: boolean };
  if (g[FETCH_PATCH_KEY]) return;
  if (typeof globalThis.fetch !== "function") {
    api.logger.warn("Global fetch unavailable, skip platform hooks fetch patch");
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const patchedInit = await patchCronAddDeliveryAccountId(input, init, api);
    if (patchedInit) init = patchedInit;
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  g[FETCH_PATCH_KEY] = true;
  api.logger.info("Platform hooks fetch patch installed");
}

// ---------------------------------------------------------------------------
// Device auto-pairing
// ---------------------------------------------------------------------------

function installAutoPairingApproval(api: OpenClawPluginApi) {
  const CHECK_INTERVAL_MS = 3000;
  let isRunning = false;

  // @ts-ignore — module available at runtime inside OpenClaw container
  type DevicePairSdk = typeof import("openclaw/plugin-sdk/device-pair");
  let sdk: DevicePairSdk | null = null;

  const loadSdk = async (): Promise<DevicePairSdk | null> => {
    if (sdk) return sdk;
    try {
      // @ts-ignore — module available at runtime inside OpenClaw container
      sdk = (await import("openclaw/plugin-sdk/device-pair")) as DevicePairSdk;
      return sdk;
    } catch { return null; }
  };

  // ── Phase 1: Create device identity + pre-pair at startup ──
  const prePairDeviceIdentity = async () => {
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
  };

  // ── Phase 2: Background polling for new requests ──
  const checkAndApprovePending = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const mod = await loadSdk();
      if (!mod) return;
      const { pending } = await mod.listDevicePairing();
      for (const request of pending) {
        if (!("requestId" in request)) continue;
        const req = request as { requestId: string; clientId?: string };
        api.logger.info(`[auto-pairing] Approving: ${req.requestId}`);
        try {
          await mod.approveDevicePairing(req.requestId);
          api.logger.info(`[auto-pairing] Approved: ${req.requestId}`);
        } catch (err) {
          api.logger.warn(`[auto-pairing] Failed: ${req.requestId}: ${String(err)}`);
        }
      }
    } catch {
      // Gateway might not be ready yet
    } finally {
      isRunning = false;
    }
  };

  prePairDeviceIdentity().catch(() => {});
  setInterval(checkAndApprovePending, CHECK_INTERVAL_MS);
  setTimeout(checkAndApprovePending, 2000);
  api.logger.info("[auto-pairing] Enabled (eager pre-pair + background polling)");
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
    installFetchProxy(api);
    installAutoPairingApproval(api);
  },
};

export default plugin;
