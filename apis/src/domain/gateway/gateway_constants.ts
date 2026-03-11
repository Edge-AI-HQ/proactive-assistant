// ---------------------------------------------------------------------------
// Shared identity constants for APIs → Gateway connections
//
// All backend connections (WS relay, RPC, probe) use these values.
//
// Key design decision: we use "gateway-client" — a valid OpenClaw client ID
// that is NOT "openclaw-control-ui", so the gateway's
// `evaluateMissingDeviceIdentity` skips the stricter Control UI auth checks
// and goes straight to `roleCanSkipDeviceIdentity`.
// Since operator + valid token (sharedAuthOk) passes that check, NO device
// identity or Ed25519 crypto is required on the APIs side.
//
// Valid client IDs (from GATEWAY_CLIENT_IDS in openclaw 2026.3.8):
//   webchat-ui, openclaw-control-ui, webchat, cli, gateway-client,
//   openclaw-macos, openclaw-ios, openclaw-android, node-host, test,
//   fingerprint, openclaw-probe
// ---------------------------------------------------------------------------

/** Client ID — must be a valid GATEWAY_CLIENT_IDS value, NOT "openclaw-control-ui". */
export const GATEWAY_CLIENT_ID = "gateway-client";

export const GATEWAY_CLIENT_ROLE = "operator";

export const GATEWAY_CLIENT_SCOPES = ["operator.admin"];
