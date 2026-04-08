/**
 * Re-export core database utilities for CLI consumption.
 *
 * CLI uses CoreContext-compatible input (env + homeDir), same as core.
 */

export {
  PinDatabaseManager,
  resolvePinDataRoot,
  type PinDatabaseManagerOptions,
  type PinDatabaseRuntimeState,
  type PinDatabaseName,
} from "../../core/db/database.js";

export { SqliteDatabase } from "../../core/db/sqlite_adapter.js";

export { buildDatabasePaths, type PinDatabasePaths } from "../../core/db/paths.js";

/** CLI convenience alias — CoreContext and ResolvePinDataRootInput are the same shape. */
export type { CoreContext as ResolvePinDataRootInput } from "../../core/context.js";
