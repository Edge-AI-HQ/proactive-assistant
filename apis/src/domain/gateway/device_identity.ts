import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// OpenClaw Gateway Device Identity
//
// Since v2026.3.x the gateway requires Ed25519 device identity on all WS
// connections.  This module generates a per-process keypair and provides
// helpers to build the `device` block for the `connect` handshake.
//
// Device-pairing bypass strategy:
//   Docker NAT and Fly cross-machine connections arrive from non-loopback IPs,
//   so the gateway's automatic loopback device-approval does not apply.  We use
//   `client.id = "openclaw-control-ui"` which enters the Control UI auth path
//   where shared-secret (token) auth success skips device-pairing entirely.
//   This is a workaround until OpenClaw provides a native config to auto-approve
//   token-authenticated devices (tracked: openclaw/openclaw#29908).
// ---------------------------------------------------------------------------

interface DeviceIdentity {
  deviceId: string;
  publicKeyB64url: string;
  privateKey: KeyObject;
}

let cached: DeviceIdentity | null = null;

/**
 * Lazily generate (and cache) a per-process Ed25519 identity.
 *
 * The keypair is ephemeral — it lives only as long as the APIs process.
 * Device pairing is bypassed via the Control UI auth path (see module header).
 */
const getOrCreateIdentity = (): DeviceIdentity => {
  if (cached) return cached;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  // Export raw 32-byte public key from SPKI DER (12-byte header + 32-byte key)
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawKey = spki.subarray(12);

  const deviceId = createHash("sha256").update(rawKey).digest("hex");
  const publicKeyB64url = Buffer.from(rawKey).toString("base64url");

  cached = { deviceId, publicKeyB64url, privateKey };
  return cached;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeviceBlock {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

/**
 * Build the `device` block for the OpenClaw `connect` handshake.
 *
 * The `challenge` must come from the gateway's `connect.challenge` event —
 * the gateway rejects connections whose device nonce doesn't match the
 * server-issued challenge.
 *
 * Signature payload format (v2 — includes server-issued nonce):
 *   `v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`
 */
// ---------------------------------------------------------------------------
// Shared client identity constants
//
// All backend-to-gateway connections (probe + RPC) use these values.
// `client.id` MUST be "openclaw-control-ui" — see module header for why.
// ---------------------------------------------------------------------------

export const GATEWAY_CLIENT_ID = "openclaw-control-ui";
export const GATEWAY_CLIENT_ROLE = "operator";
export const GATEWAY_CLIENT_SCOPES = ["operator.admin"];

export const buildDeviceBlock = (
  params: {
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    token: string;
  },
  challenge: { nonce: string; ts: number },
): DeviceBlock => {
  const identity = getOrCreateIdentity();

  const { nonce, ts } = challenge;

  const payload = [
    "v2",
    identity.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(ts),
    params.token,
    nonce,
  ].join("|");

  const signature = sign(null, Buffer.from(payload), identity.privateKey);

  return {
    id: identity.deviceId,
    publicKey: identity.publicKeyB64url,
    signature: Buffer.from(signature).toString("base64url"),
    signedAt: ts,
    nonce,
  };
};
