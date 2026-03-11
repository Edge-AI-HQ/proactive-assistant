// ---------------------------------------------------------------------------
// Shared identity constants for APIs → Gateway connections
//
// All backend connections (WS relay, RPC, probe) use these values.
//
// Key design decision: we use a NON-Control-UI client ID ("pin-ai-backend")
// so the gateway's `evaluateMissingDeviceIdentity` skips the stricter
// Control UI auth checks and goes straight to `roleCanSkipDeviceIdentity`.
// Since operator + valid token (sharedAuthOk) passes that check, NO device
// identity or Ed25519 crypto is required on the APIs side.
//
// See: openclaw/src/gateway/role-policy.ts
//   roleCanSkipDeviceIdentity(role, sharedAuthOk) = role === "operator" && sharedAuthOk
// ---------------------------------------------------------------------------

/** Client ID — intentionally NOT "openclaw-control-ui" to avoid Control UI security gates. */
export const GATEWAY_CLIENT_ID = "pin-ai-backend";

export const GATEWAY_CLIENT_ROLE = "operator";

export const GATEWAY_CLIENT_SCOPES = ["operator.admin"];
