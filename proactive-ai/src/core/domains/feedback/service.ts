import { FeedbackRepository } from "./repository.js";
import type { FeedbackEventRecord } from "./schema.js";
import type { FeedbackStats } from "./repository.js";

import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import {
  validateEnum,
  parseSinceToISO,
  rejectDangerousChars,
  parseOptionalInt,
} from "../../validation.js";

// ── Valid enum constants (exported for CLI & server reuse) ──

export const VALID_KINDS = [
  "card_open",
  "card_action",
  "explicit_rating",
  "dismiss",
  "snooze",
  "text_feedback",
] as const;

export const VALID_ACTIONS = [
  "confirm",
  "modify",
  "later",
  "thumbs_up",
  "thumbs_down",
  "open_detail",
  "click_cta",
] as const;

export const VALID_SOURCES = [
  "user_direct",
  "user_derived",
  "agent_analysis",
] as const;

export const VALID_BASKETS = [
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
] as const;

export const VALID_CHANNELS = [
  "telegram",
  "web",
  "mobile",
  "im",
] as const;

const sanitizeMetadataValue = (path: string, value: unknown): void => {
  if (typeof value === "string") {
    rejectDangerousChars(path, value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      sanitizeMetadataValue(`${path}[${index}]`, entry);
    });
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      rejectDangerousChars(`${path} key`, key);
      sanitizeMetadataValue(`${path}.${key}`, entry);
    }
  }
};

const parseMetadata = (
  raw?: string | Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (raw === undefined) return undefined;

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ValidationError(
        "INVALID_ARGUMENT",
        "metadata must be a JSON object",
      );
    }

    sanitizeMetadataValue("metadata", parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ValidationError(
      "INVALID_ARGUMENT",
      "metadata must be valid JSON",
    );
  }
};

// ── Repository factory ──

const createRepository = async (ctx: CoreContext): Promise<FeedbackRepository> => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new FeedbackRepository(manager.open("pin"));
};

// ── Service functions ──

export const logFeedback = async (
  ctx: CoreContext,
  input: {
    kind: string;
    action?: string;
    pushId?: string;
    intentCardId?: string;
    intentKey?: string;
    conversationId?: string;
    messageId?: string;
    source?: string;
    basket?: string;
    channel?: string;
    value?: string;
    text?: string;
    metadata?: string | Record<string, unknown>;
    at?: string;
  },
): Promise<FeedbackEventRecord> => {
  validateEnum("kind", input.kind, VALID_KINDS);
  if (input.action) validateEnum("action", input.action, VALID_ACTIONS);
  if (input.source) validateEnum("source", input.source, VALID_SOURCES);
  if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
  if (input.channel) validateEnum("channel", input.channel, VALID_CHANNELS);

  if (input.text) rejectDangerousChars("text", input.text);
  if (input.value) rejectDangerousChars("value", input.value);

  const repository = await createRepository(ctx);
  const metadata = parseMetadata(input.metadata);
  const intentKey =
    input.intentKey
    ?? (typeof metadata?.["intentKey"] === "string" ? metadata["intentKey"] : undefined);

  return repository.create({
    kind: input.kind,
    action: input.action,
    pushId: input.pushId,
    intentCardId: input.intentCardId,
    intentKey,
    conversationId: input.conversationId,
    messageId: input.messageId,
    source: input.source,
    basket: input.basket,
    channel: input.channel,
    value: input.value,
    text: input.text,
    metadata,
    createdAt: input.at,
  });
};

export const listFeedback = async (
  ctx: CoreContext,
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
): Promise<FeedbackEventRecord[]> => {
  if (input.kind) validateEnum("kind", input.kind, VALID_KINDS);
  if (input.action) validateEnum("action", input.action, VALID_ACTIONS);
  if (input.source) validateEnum("source", input.source, VALID_SOURCES);
  if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
  if (input.channel) validateEnum("channel", input.channel, VALID_CHANNELS);

  const repository = await createRepository(ctx);
  return repository.list({
    since: input.since ? parseSinceToISO(input.since) : undefined,
    kind: input.kind,
    action: input.action,
    source: input.source,
    basket: input.basket,
    channel: input.channel,
    pushId: input.pushId,
    intentCardId: input.intentCardId,
    limit: parseOptionalInt(input.limit, 50),
  });
};

export const getFeedback = async (
  ctx: CoreContext,
  input: { id: string },
): Promise<FeedbackEventRecord> => {
  const repository = await createRepository(ctx);
  const record = await repository.getById(input.id);

  if (!record) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Feedback event ${input.id} not found`,
      "run `pin feedback list --since 7d` to see recent events",
    );
  }

  return record;
};

export const statsFeedback = async (
  ctx: CoreContext,
  input: {
    since?: string;
    basket?: string;
    channel?: string;
  },
): Promise<FeedbackStats> => {
  if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
  if (input.channel) validateEnum("channel", input.channel, VALID_CHANNELS);

  const repository = await createRepository(ctx);
  return repository.stats({
    since: input.since ? parseSinceToISO(input.since) : undefined,
    basket: input.basket,
    channel: input.channel,
  });
};
