import type { PinEnvelope } from "./output/envelope.js";

export interface RunCliResult {
  exitCode: number;
  stdout: PinEnvelope<unknown>;
}

export interface CliRuntimeInput {
  env: Record<string, string | undefined>;
  homeDir: string;
}

export interface ResultRef {
  current: RunCliResult | null;
}
