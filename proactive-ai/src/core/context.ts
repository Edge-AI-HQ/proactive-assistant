/**
 * CoreContext — the dependency injection surface for all core services.
 *
 * Replaces CliRuntimeInput. Same shape, but no CLI-specific naming.
 * CLI and Server both create a CoreContext and pass it to core services.
 */

export interface CoreContext {
  /** Environment variables (process.env or test override). */
  env: Record<string, string | undefined>;
  /** User home directory (os.homedir() or test override). */
  homeDir: string;
}
