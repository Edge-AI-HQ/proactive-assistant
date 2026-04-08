import type { PinEnvelope } from "./output/envelope.js";
import type { CoreContext } from "../core/context.js";

export interface RunCliResult {
  exitCode: number;
  stdout: PinEnvelope<unknown>;
}

/** CLI runtime input is the same shape as CoreContext. */
export type CliRuntimeInput = CoreContext;

export interface ResultRef {
  current: RunCliResult | null;
}
