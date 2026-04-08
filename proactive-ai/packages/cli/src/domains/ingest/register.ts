import { Command } from "commander";

import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { runIngest } from "./service.js";

export const registerIngestCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const ingest = new Command("ingest").description(
    "Deterministic ingest commands that fetch external data and store facts locally",
  );

  ingest
    .command("run")
    .description("Fetch world/personal data and store deduplicated incremental facts locally")
    .option("--domains <domains>", "comma-separated domains: world,personal", "world,personal")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await runIngest(runtime, options);
    });

  program.addCommand(ingest);

  registerCommand({
    domain: "ingest",
    command: "run",
    description: "Fetch world/personal data and store deduplicated incremental facts locally",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "domains", type: "string", required: false, default: "world,personal", description: "Comma-separated domains to ingest: world,personal" },
    ],
  });
};
