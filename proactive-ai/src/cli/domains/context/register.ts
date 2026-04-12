import { Command } from "commander";

import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { getIncrementalContext } from "./service.js";

export const registerContextCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const context = new Command("context").description(
    "Agent-facing local context queries over ingested facts",
  );

  context
    .command("incremental")
    .description("Return unprocessed incremental facts and a run token")
    .option("--limit <limit>", "max facts to include", "50")
    .option("--min-age-ms <minAgeMs>", "minimum age in milliseconds before a fact becomes eligible", "0")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getIncrementalContext(runtime, options);
    });

  program.addCommand(context);

  registerCommand({
    domain: "context",
    command: "incremental",
    description: "Return unprocessed incremental facts and a run token for agent consumption",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "limit", type: "number", required: false, default: "50", description: "Maximum facts to include" },
      { name: "min-age-ms", type: "number", required: false, default: "0", description: "Minimum age in milliseconds before pending facts are eligible" },
    ],
  });
};
