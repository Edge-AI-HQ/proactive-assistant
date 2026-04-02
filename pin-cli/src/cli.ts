import { Command } from "commander";
import { CommanderError } from "commander";

import { registerProfileCommands } from "./domains/profile/register.js";
import { registerSysCommands } from "./domains/sys/register.js";
import {
  errorEnvelope,
} from "./output/envelope.js";
import type { CliRuntimeInput, ResultRef, RunCliResult } from "./runtime.js";

const createProgram = (runtime: CliRuntimeInput): Command => {
  const program = new Command();
  program.name("pin").exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerSysCommands(program, runtime, resultRef);
  registerProfileCommands(program, runtime, resultRef);
  return program;
};

const resultRef: ResultRef = {
  current: null as RunCliResult | null,
};

export async function runCli(
  argv: string[],
  runtimeOverride?: Partial<CliRuntimeInput>,
): Promise<RunCliResult> {
  resultRef.current = null;
  const runtime: CliRuntimeInput = {
    env: { ...process.env, ...runtimeOverride?.env },
    homeDir: runtimeOverride?.homeDir || process.cwd(),
  };
  const program = createProgram(runtime);

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
        "INVALID_ARGUMENT",
        "Unknown command",
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
      "INVALID_ARGUMENT",
      "Unknown command",
    ),
  };
}
