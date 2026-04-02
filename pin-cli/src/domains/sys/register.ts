import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { runSysDoctor } from "./doctor.js";

export const registerSysCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const sys = new Command("sys");

  sys
    .command("doctor")
    .option("--json")
    .action(async () => {
      resultRef.current = {
        exitCode: 0,
        stdout: await runSysDoctor(runtime),
      };
    });

  program.addCommand(sys);
};
