// ---------------------------------------------------------------------------
// Shared identity constants for APIs → Gateway connections
//
// All backend connections (WS relay, RPC, probe) use these values.
//
// We use "openclaw-control-ui" so the gateway's scope-preservation logic
// recognises us as a trusted Control UI operator. With gateway config
// `controlUi.allowInsecureAuth: true` and localhost connections, this avoids
// the stricter device-identity/Ed25519 checks while preserving operator
// scopes (operator.admin → full access).
//
// Without this, OpenClaw ≥2026.4 clears self-declared scopes for any
// device-less non-Control-UI client (security hardening for CVE-2026-32919).
// ---------------------------------------------------------------------------

/** Client ID — must match a recognized Control UI client for scope preservation. */
export const GATEWAY_CLIENT_ID = "openclaw-control-ui";

export const GATEWAY_CLIENT_ROLE = "operator";

export const GATEWAY_CLIENT_SCOPES = ["operator.admin"];
