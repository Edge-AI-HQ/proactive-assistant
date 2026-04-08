import { okEnvelope } from "./envelope.js";
import type { RunCliResult } from "../runtime.js";

export interface DryRunResult {
  dryRun: true;
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  table: string;
  data: Record<string, unknown>;
}

export const dryRunEnvelope = (
  domain: string,
  command: string,
  operation: DryRunResult["operation"],
  table: string,
  data: Record<string, unknown>,
): RunCliResult => ({
  exitCode: 0,
  stdout: okEnvelope<DryRunResult>(domain, command, {
    dryRun: true,
    operation,
    table,
    data,
  }),
});
