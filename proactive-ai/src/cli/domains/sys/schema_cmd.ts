import { okEnvelope, errorEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import { getCommand, getAllCommands } from "../../registry.js";
import type { RunCliResult } from "../../runtime.js";

export const runSysSchema = (path?: string): RunCliResult => {
  if (!path) {
    const all = getAllCommands();
    return {
      exitCode: 0,
      stdout: okEnvelope("sys", "schema", {
        commands: all.map((c) => ({
          path: `${c.domain}.${c.command.replace(/ /g, ".")}`,
          description: c.description,
          risk: c.risk,
        })),
      }),
    };
  }

  const parts = path.split(".");
  if (parts.length < 2) {
    return {
      exitCode: 2,
      stdout: errorEnvelope(
        "sys",
        "schema",
        ErrorType.VALIDATION,
        "INVALID_ARGUMENT",
        `Invalid schema path '${path}', expected format: domain.command`,
        "run `pin sys schema` to list all available commands",
      ),
    };
  }

  const domain = parts[0];
  const command = parts.slice(1).join(" ");
  const meta = getCommand(domain, command);

  if (!meta) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "sys",
        "schema",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `Command '${path}' not found in registry`,
        "run `pin sys schema` to list all available commands",
      ),
    };
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("sys", "schema", {
      domain: meta.domain,
      command: meta.command,
      description: meta.description,
      flags: meta.flags,
      risk: meta.risk,
      supportsDryRun: meta.supportsDryRun,
    }),
  };
};
