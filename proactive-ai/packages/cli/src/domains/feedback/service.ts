import { callCore } from "../../output/adapter.js";
import { feedback as coreFeedback } from "@pin-ai/core";
import { dryRunEnvelope } from "../../output/dryrun.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

export const logFeedback = async (
  runtime: CliRuntimeInput,
  input: {
    kind: string;
    action?: string;
    pushId?: string;
    intentCardId?: string;
    conversationId?: string;
    messageId?: string;
    source?: string;
    basket?: string;
    channel?: string;
    value?: string;
    text?: string;
    metadata?: string | Record<string, unknown>;
    at?: string;
    dryRun?: boolean;
  },
): Promise<RunCliResult> => {
  if (input.dryRun) {
    const { dryRun: _, ...rest } = input;
    return dryRunEnvelope("feedback", "log", "INSERT", "feedback_events", rest as unknown as Record<string, unknown>);
  }

  const { dryRun: _, ...coreInput } = input;
  return callCore("feedback", "log", () => coreFeedback.logFeedback(runtime, coreInput));
};

export const listFeedback = async (
  runtime: CliRuntimeInput,
  input: {
    since?: string;
    kind?: string;
    action?: string;
    source?: string;
    basket?: string;
    channel?: string;
    pushId?: string;
    intentCardId?: string;
    limit?: string;
  },
): Promise<RunCliResult> =>
  callCore("feedback", "list", () => coreFeedback.listFeedback(runtime, input));

export const getFeedback = async (
  runtime: CliRuntimeInput,
  input: { id: string },
): Promise<RunCliResult> =>
  callCore("feedback", "get", () => coreFeedback.getFeedback(runtime, input));

export const statsFeedback = async (
  runtime: CliRuntimeInput,
  input: {
    since?: string;
    basket?: string;
    channel?: string;
  },
): Promise<RunCliResult> =>
  callCore("feedback", "stats", () => coreFeedback.statsFeedback(runtime, input));
