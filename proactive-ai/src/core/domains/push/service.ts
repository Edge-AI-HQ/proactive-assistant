import { PushRepository } from "./repository.js";
import type { PushRecordWithOutcomes } from "./repository.js";
import {
  VALID_PUSH_KINDS,
  VALID_PUSH_CHANNELS,
  VALID_BASKETS,
  VALID_OUTCOME_STATUSES,
  type PushRecordRow,
  type PushOutcomeRow,
} from "./schema.js";

import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import { NotFoundError } from "../../errors.js";
import {
  validateEnum,
  parseSinceToISO,
  rejectDangerousChars,
  parseOptionalInt,
} from "../../validation.js";

// Re-export schema constants for convenience
export { VALID_PUSH_KINDS, VALID_PUSH_CHANNELS, VALID_BASKETS, VALID_OUTCOME_STATUSES };

// ── Repository factory ──

const createRepository = async (ctx: CoreContext): Promise<PushRepository> => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new PushRepository(manager.open("pin"));
};

// ── Service functions ──

export const recordPush = async (
  ctx: CoreContext,
  input: {
    kind: string;
    title: string;
    intentCardId?: string;
    basket?: string;
    channel?: string;
    ref?: string;
    reason?: string;
  },
): Promise<PushRecordRow> => {
  validateEnum("kind", input.kind, VALID_PUSH_KINDS);
  if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
  if (input.channel) validateEnum("channel", input.channel, VALID_PUSH_CHANNELS);
  rejectDangerousChars("title", input.title);
  if (input.reason) rejectDangerousChars("reason", input.reason);

  const repository = await createRepository(ctx);
  return repository.createRecord({
    kind: input.kind,
    title: input.title,
    intentCardId: input.intentCardId,
    basket: input.basket,
    channel: input.channel,
    ref: input.ref,
    reason: input.reason,
  });
};

export const listPushHistory = async (
  ctx: CoreContext,
  input: {
    limit?: string;
    kind?: string;
    basket?: string;
    channel?: string;
    since?: string;
  },
): Promise<PushRecordRow[]> => {
  if (input.kind) validateEnum("kind", input.kind, VALID_PUSH_KINDS);
  if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
  if (input.channel) validateEnum("channel", input.channel, VALID_PUSH_CHANNELS);

  const repository = await createRepository(ctx);
  const limit = parseOptionalInt(input.limit, 50);

  return repository.listRecords({
    kind: input.kind,
    basket: input.basket,
    channel: input.channel,
    since: input.since ? parseSinceToISO(input.since) : undefined,
    limit,
  });
};

export const getPush = async (
  ctx: CoreContext,
  input: { id: string },
): Promise<PushRecordWithOutcomes> => {
  const repository = await createRepository(ctx);
  const record = await repository.getRecordWithOutcomes(input.id);

  if (!record) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Push record ${input.id} not found`,
      "run `pin push history` to see recent pushes",
    );
  }

  return record;
};

export const recordOutcome = async (
  ctx: CoreContext,
  input: {
    id: string;
    status: string;
  },
): Promise<PushOutcomeRow> => {
  validateEnum("status", input.status, VALID_OUTCOME_STATUSES);

  const repository = await createRepository(ctx);

  const pushRecord = await repository.getRecordById(input.id);
  if (!pushRecord) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Push record ${input.id} not found`,
      "run `pin push history` to see recent pushes",
    );
  }

  return repository.createOutcome({
    pushId: input.id,
    status: input.status,
  });
};

export const findSimilarPushes = async (
  ctx: CoreContext,
  input: {
    kind: string;
    ref?: string;
    title?: string;
    since?: string;
  },
): Promise<PushRecordRow[]> => {
  validateEnum("kind", input.kind, VALID_PUSH_KINDS);

  const repository = await createRepository(ctx);
  return repository.findSimilar({
    kind: input.kind,
    ref: input.ref,
    title: input.title,
    since: input.since ? parseSinceToISO(input.since) : undefined,
    limit: 20,
  });
};
