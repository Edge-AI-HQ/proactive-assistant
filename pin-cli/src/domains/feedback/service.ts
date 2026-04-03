import { FeedbackRepository } from "./repository.js";

import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { dryRunEnvelope } from "../../output/dryrun.js";
import { ErrorType } from "../../output/errors.js";
import { rejectDangerousChars } from "../../output/sanitize.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

const VALID_KINDS = [
  "card_open",
  "card_action",
  "explicit_rating",
  "dismiss",
  "snooze",
  "text_feedback",
] as const;

const VALID_ACTIONS = [
  "confirm",
  "modify",
  "later",
  "thumbs_up",
  "thumbs_down",
  "open_detail",
  "click_cta",
] as const;

const VALID_SOURCES = [
  "user_direct",
  "user_derived",
  "agent_analysis",
] as const;

const VALID_BASKETS = [
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
] as const;

const VALID_CHANNELS = [
  "telegram",
  "web",
  "mobile",
  "im",
] as const;

const createRepository = async (runtime: CliRuntimeInput) => {
  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new FeedbackRepository(manager.open("pin"));
};

const parseSinceToISO = (since: string): string => {
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid --since format: ${since}. Use e.g. 7d, 24h, 2w`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  let ms = 0;

  if (unit === "h") ms = amount * 60 * 60 * 1000;
  else if (unit === "d") ms = amount * 24 * 60 * 60 * 1000;
  else if (unit === "w") ms = amount * 7 * 24 * 60 * 60 * 1000;

  return new Date(now - ms).toISOString();
};

const validateEnum = (
  paramName: string,
  value: string | undefined,
  allowed: readonly string[],
): void => {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(
      `Invalid --${paramName}: ${value}. Allowed: ${allowed.join(", ")}`,
    );
  }
};

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
    at?: string;
    dryRun?: boolean;
  },
): Promise<RunCliResult> => {
  try {
    validateEnum("kind", input.kind, VALID_KINDS);
    if (input.action) validateEnum("action", input.action, VALID_ACTIONS);
    if (input.source) validateEnum("source", input.source, VALID_SOURCES);
    if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
    if (input.channel) validateEnum("channel", input.channel, VALID_CHANNELS);

    if (input.text) rejectDangerousChars("text", input.text);
    if (input.value) rejectDangerousChars("value", input.value);

    const data = {
      kind: input.kind,
      action: input.action,
      pushId: input.pushId,
      intentCardId: input.intentCardId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      source: input.source,
      basket: input.basket,
      channel: input.channel,
      value: input.value,
      text: input.text,
      createdAt: input.at,
    };

    if (input.dryRun) {
      return dryRunEnvelope("feedback", "log", "INSERT", "feedback_events", data as unknown as Record<string, unknown>);
    }

    const repository = await createRepository(runtime);
    const record = await repository.create(data);

    return {
      exitCode: 0,
      stdout: okEnvelope("feedback", "log", record),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown feedback log error";

    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "feedback",
        "log",
        message.includes("Invalid")
          ? ErrorType.VALIDATION
          : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
        "check `pin feedback log --help` for valid options",
      ),
    };
  }
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
): Promise<RunCliResult> => {
  try {
    if (input.kind) validateEnum("kind", input.kind, VALID_KINDS);
    if (input.action) validateEnum("action", input.action, VALID_ACTIONS);
    if (input.source) validateEnum("source", input.source, VALID_SOURCES);
    if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
    if (input.channel) validateEnum("channel", input.channel, VALID_CHANNELS);

    const repository = await createRepository(runtime);
    const records = await repository.list({
      since: input.since ? parseSinceToISO(input.since) : undefined,
      kind: input.kind,
      action: input.action,
      source: input.source,
      basket: input.basket,
      channel: input.channel,
      pushId: input.pushId,
      intentCardId: input.intentCardId,
      limit: input.limit ? parseInt(input.limit, 10) : 50,
    });

    return {
      exitCode: 0,
      stdout: okEnvelope("feedback", "list", records),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown feedback list error";

    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "feedback",
        "list",
        message.includes("Invalid")
          ? ErrorType.VALIDATION
          : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
      ),
    };
  }
};

export const getFeedback = async (
  runtime: CliRuntimeInput,
  input: { id: string },
): Promise<RunCliResult> => {
  try {
    const repository = await createRepository(runtime);
    const record = await repository.getById(input.id);

    if (!record) {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "feedback",
          "get",
          ErrorType.NOT_FOUND,
          "NOT_FOUND",
          `Feedback event ${input.id} not found`,
          "run `pin feedback list --since 7d` to see recent events",
        ),
      };
    }

    return {
      exitCode: 0,
      stdout: okEnvelope("feedback", "get", record),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown feedback get error";

    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "feedback",
        "get",
        ErrorType.INTERNAL,
        "INTERNAL",
        message,
      ),
    };
  }
};

export const statsFeedback = async (
  runtime: CliRuntimeInput,
  input: {
    since?: string;
    basket?: string;
    channel?: string;
  },
): Promise<RunCliResult> => {
  try {
    if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
    if (input.channel) validateEnum("channel", input.channel, VALID_CHANNELS);

    const repository = await createRepository(runtime);
    const stats = await repository.stats({
      since: input.since ? parseSinceToISO(input.since) : undefined,
      basket: input.basket,
      channel: input.channel,
    });

    return {
      exitCode: 0,
      stdout: okEnvelope("feedback", "stats", stats),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown feedback stats error";

    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "feedback",
        "stats",
        message.includes("Invalid")
          ? ErrorType.VALIDATION
          : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
      ),
    };
  }
};
