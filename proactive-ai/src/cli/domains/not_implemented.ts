import { errorEnvelope } from "../output/envelope.js";
import { ErrorType } from "../output/errors.js";
import type { RunCliResult } from "../runtime.js";

export const notImplemented = (
  domain: string,
  command: string,
  hint?: string,
): RunCliResult => ({
  exitCode: 1,
  stdout: errorEnvelope(
    domain,
    command,
    ErrorType.NOT_IMPLEMENTED,
    "NOT_IMPLEMENTED",
    `${domain} ${command} is not yet implemented`,
    hint ?? `this command will be available in a future release`,
  ),
});
