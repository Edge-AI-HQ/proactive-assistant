import { Command } from "commander";
import { CommanderError } from "commander";

import { registerProfileCommands } from "./domains/profile/register.js";
import { registerSysCommands } from "./domains/sys/register.js";
import { registerFeedbackCommands } from "./domains/feedback/register.js";
import { registerPushCommands } from "./domains/push/register.js";
import { errorEnvelope } from "./output/envelope.js";
import { ErrorType } from "./output/errors.js";
import type { CliRuntimeInput, ResultRef, RunCliResult } from "./runtime.js";

const createProgram = (runtime: CliRuntimeInput, resultRef: ResultRef): Command => {
  const program = new Command();
  program.name("pin").exitOverride();
  program.option("--format <fmt>", "output format: json | table | ndjson | pretty", "json");
  program.option("--dry-run", "preview operation without executing");
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  registerSysCommands(program, runtime, resultRef);
  registerProfileCommands(program, runtime, resultRef);
  registerFeedbackCommands(program, runtime, resultRef);
  registerPushCommands(program, runtime, resultRef);

  return program;
};

export async function runCli(
  argv: string[],
  runtimeOverride?: Partial<CliRuntimeInput>,
): Promise<RunCliResult> {
  const resultRef: ResultRef = { current: null };
  const runtime: CliRuntimeInput = {
    env: { ...process.env, ...runtimeOverride?.env },
    homeDir: runtimeOverride?.homeDir || process.cwd(),
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
