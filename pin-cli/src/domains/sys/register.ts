import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import { registerCommand } from "../../registry.js";
import { runSysDoctor } from "./doctor.js";
import { runSysSchema } from "./schema_cmd.js";

export const registerSysCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const sys = new Command("sys").description("System maintenance and diagnostics");

  sys
    .command("doctor")
    .description("Run health checks")
    .option("--json")
    .action(async () => {
      resultRef.current = {
        exitCode: 0,
        stdout: await runSysDoctor(runtime),
      };
    });

  sys
    .command("schema [path]")
    .description("Introspect command schema (e.g. pin sys schema profile.get)")
    .option("--json")
    .action((path?: string) => {
      resultRef.current = runSysSchema(path);
    });

  sys
    .command("migrate")
    .description("Run database migrations")
    .option("--json")
    .action(() => {
      resultRef.current = {
        exitCode: 1,
        stdout: errorEnvelope(
          "sys",
          "migrate",
          ErrorType.NOT_IMPLEMENTED,
          "NOT_IMPLEMENTED",
          "Database migration not yet implemented",
          "migrations are auto-applied via ensureSchema() on first use",
        ),
      };
    });

  sys
    .command("reindex")
    .description("Rebuild search indexes")
    .option("--domain <domain>", "target domain to reindex")
    .option("--json")
    .action(() => {
      resultRef.current = {
        exitCode: 1,
        stdout: errorEnvelope(
          "sys",
          "reindex",
          ErrorType.NOT_IMPLEMENTED,
          "NOT_IMPLEMENTED",
          "Reindex not yet implemented",
        ),
      };
    });

  sys
    .command("export")
    .description("Export data")
    .option("--path <path>", "export directory")
    .option("--json")
    .action(() => {
      resultRef.current = {
        exitCode: 1,
        stdout: errorEnvelope(
          "sys",
          "export",
          ErrorType.NOT_IMPLEMENTED,
          "NOT_IMPLEMENTED",
          "Export not yet implemented",
        ),
      };
    });

  sys
    .command("import")
    .description("Import data")
    .option("--path <path>", "import directory")
    .option("--yes", "skip confirmation")
    .option("--json")
    .action(() => {
      resultRef.current = {
        exitCode: 1,
        stdout: errorEnvelope(
          "sys",
          "import",
          ErrorType.NOT_IMPLEMENTED,
          "NOT_IMPLEMENTED",
          "Import not yet implemented",
        ),
      };
    });

  program.addCommand(sys);

  registerCommand({
    domain: "sys",
    command: "doctor",
    description: "Run health checks on CLI environment",
    risk: "read",
    supportsDryRun: false,
    flags: [{ name: "json", type: "boolean", required: false, description: "Output as JSON" }],
  });

  registerCommand({
    domain: "sys",
    command: "schema",
    description: "Introspect command parameters and metadata",
    risk: "read",
    supportsDryRun: false,
    flags: [{ name: "path", type: "string", required: false, description: "Command path (e.g. profile.get)" }],
  });
};
