import { Command } from "commander";
import { CommanderError } from "commander";
import { homedir } from "node:os";

import { registerFeedbackCommands } from "./domains/feedback/register.js";
import { registerIngestCommands } from "./domains/ingest/register.js";
import { registerMemoryCommands } from "./domains/memory/register.js";
import { registerProfileCommands } from "./domains/profile/register.js";
import { registerPersonalCommands } from "./domains/personal/register.js";
import { registerPushCommands } from "./domains/push/register.js";
import { registerCardsCommands } from "./domains/cards/register.js";
import { registerSysCommands } from "./domains/sys/register.js";
import { registerWorldCommands } from "./domains/world/register.js";
import { registerContextCommands } from "./domains/context/register.js";
import { registerLoopCommands } from "./domains/loop/register.js";
import { errorEnvelope } from "./output/envelope.js";
import { ErrorType } from "./output/errors.js";
import type { CliRuntimeInput, ResultRef, RunCliResult } from "./runtime.js";

const createProgram = (runtime: CliRuntimeInput, resultRef: ResultRef): Command => {
  const program = new Command();
  program.name("pin").exitOverride();
  program.option("--format <fmt>", "output format: json | table | ndjson | pretty", "json");
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  registerSysCommands(program, runtime, resultRef);
  registerProfileCommands(program, runtime, resultRef);
  registerMemoryCommands(program, runtime, resultRef);
  registerWorldCommands(program, runtime, resultRef);
  registerIngestCommands(program, runtime, resultRef);
  registerContextCommands(program, runtime, resultRef);
  registerLoopCommands(program, runtime, resultRef);
  registerFeedbackCommands(program, runtime, resultRef);
  registerCardsCommands(program, runtime, resultRef);
  registerPushCommands(program, runtime, resultRef);
  registerPersonalCommands(program, runtime, resultRef);

  // Commander does not propagate exitOverride/configureOutput to subcommands.
  // Without this, bad args on nested commands (e.g. `personal exec` without --tool)
  // call process.exit(1), killing the host process when run in-process.
  const silentOutput = { writeOut: () => {}, writeErr: () => {} };
  const propagate = (cmd: Command) => {
    for (const sub of cmd.commands) {
      sub.exitOverride();
      sub.configureOutput(silentOutput);
      propagate(sub);
    }
  };
  propagate(program);

  return program;
};

export async function runCli(
  argv: string[],
  runtimeOverride?: Partial<CliRuntimeInput>,
): Promise<RunCliResult> {
  const resultRef: ResultRef = { current: null };
  const runtime: CliRuntimeInput = {
    env: { ...process.env, ...runtimeOverride?.env },
    homeDir: runtimeOverride?.homeDir || homedir(),
  };
  const program = createProgram(runtime, resultRef);

  try {
    await program.parseAsync(["node", "pin", ...argv]);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }

    return {
      exitCode: 2,
      stdout: errorEnvelope(
        "cli",
        argv.join(" "),
        ErrorType.VALIDATION,
        "INVALID_ARGUMENT",
        "Unknown command",
        "run `pin --help` to see available commands",
      ),
    };
  }

  if (resultRef.current) {
    return resultRef.current;
  }

  return {
    exitCode: 2,
    stdout: errorEnvelope(
      "cli",
      argv.join(" "),
      ErrorType.VALIDATION,
      "INVALID_ARGUMENT",
      "Unknown command",
      "run `pin --help` to see available commands",
    ),
  };
}
