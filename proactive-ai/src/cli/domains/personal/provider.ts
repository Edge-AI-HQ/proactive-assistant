/**
 * Re-export core Composio provider for CLI usage.
 *
 * CliRuntimeInput === CoreContext, so core's provider works directly.
 * All provider logic lives in src/core/domains/personal/provider.ts.
 */
export {
  type PersonalProvider,
  type PersonalConnection,
  type PersonalToolInfo,
  type PersonalToolSchema,
  type PersonalExecResult,
  createPersonalProvider,
  extractIdentity,
} from "../../../core/domains/personal/provider.js";
