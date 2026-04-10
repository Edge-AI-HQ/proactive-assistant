/**
 * Re-export core Composio provider for CLI usage.
 *
 * CliRuntimeInput extends the core context shape, so the core provider works
 * directly and stays in sync with server-side behavior.
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
