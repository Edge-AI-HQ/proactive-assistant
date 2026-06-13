/**
 * Composio userInfo → short label — re-exported from @pin-ai/core
 * (domain/composio-identity, the shared SSOT). Kept at this path so existing
 * `@/lib/composio-display-identity` importers keep working.
 */
export {
  extractComposioDisplayIdentity,
  formatComposioConnectionIdentity,
  formatComposioToolkitName,
  formatOptionalComposioConnectionIdentity,
  resolveComposioConnectionIdentity,
  type ComposioIdentityConnection,
} from "@pin-ai/core";
