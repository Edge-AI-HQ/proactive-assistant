import { callCore } from "../../output/adapter.js";
import { push as corePush } from "../../../core/index.js";
import { dryRunEnvelope } from "../../output/dryrun.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

export const recordPush = async (
  runtime: CliRuntimeInput,
  input: {
    kind: string;
    title: string;
    intentCardId?: string;
    basket?: string;
    channel?: string;
    ref?: string;
    reason?: string;
    dryRun?: boolean;
  },
): Promise<RunCliResult> => {
  if (input.dryRun) {
    const { dryRun: _, ...rest } = input;
    return dryRunEnvelope("push", "record", "INSERT", "push_records", rest as unknown as Record<string, unknown>);
  }

  const { dryRun: _, ...coreInput } = input;
  return callCore("push", "record", () => corePush.recordPush(runtime, coreInput));
};

export const listPushHistory = async (
  runtime: CliRuntimeInput,
  input: {
    limit?: string;
    kind?: string;
    basket?: string;
    channel?: string;
    since?: string;
  },
): Promise<RunCliResult> =>
  callCore("push", "history", () => corePush.listPushHistory(runtime, input));

export const getPush = async (
  runtime: CliRuntimeInput,
  input: { id: string },
): Promise<RunCliResult> =>
  callCore("push", "get", () => corePush.getPush(runtime, input));

export const recordOutcome = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    status: string;
    dryRun?: boolean;
  },
): Promise<RunCliResult> => {
  if (input.dryRun) {
    return dryRunEnvelope("push", "outcome", "INSERT", "push_outcomes", {
      pushId: input.id,
      status: input.status,
    });
  }

  const { dryRun: _, ...coreInput } = input;
  return callCore("push", "outcome", () => corePush.recordOutcome(runtime, coreInput));
};

export const findSimilarPushes = async (
  runtime: CliRuntimeInput,
  input: {
    kind: string;
    ref?: string;
    title?: string;
    since?: string;
  },
): Promise<RunCliResult> =>
  callCore("push", "find-similar", () => corePush.findSimilarPushes(runtime, input));
