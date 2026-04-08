import { Command } from "commander";

import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { commitLoopRun, getLoopStatus } from "./service.js";

export const registerLoopCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const loop = new Command("loop").description(
    "Agent loop lifecycle commands over local incremental context",
  );

  loop
    .command("commit")
    .description("Commit a run token after the current agent run has consumed it")
    .requiredOption("--run-token <runToken>", "run token from `pin context incremental`")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await commitLoopRun(runtime, options);
    });

  loop
    .command("status")
    .description("Show pending and processed counts plus recent loop status")
    .option("--json")
    .action(async () => {
      resultRef.current = await getLoopStatus(runtime);
    });

  program.addCommand(loop);

  registerCommand({
    domain: "loop",
    command: "commit",
    description: "Commit a run token after cards are generated from incremental context",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "run-token", type: "string", required: true, description: "Run token from `pin context incremental`" },
    ],
  });

  registerCommand({
    domain: "loop",
    command: "status",
    description: "Show local loop status, pending count, and processed count",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });
};
