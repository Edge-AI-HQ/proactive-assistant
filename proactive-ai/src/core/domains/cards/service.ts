import { GeneratedIntentCardRepository } from "./repository.js";
import type {
  GeneratedIntentCardRow,
  GeneratedIntentCardWithThreadContextRow,
  ThreadContext,
} from "./schema.js";

import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import type { IntentCard } from "../../types/intent-card.js";
import { makeIntentKey, makeTitleKey } from "../../../shared/intent-key.js";
import {
  validateEnum,
  parseSinceToISO,
  parseOptionalInt,
  rejectDangerousChars,
} from "../../validation.js";
import { buildDefaultThreadState, listThreadStates, seedGeneratedCards } from "../intent-state/service.js";

export const VALID_BASKETS = [
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
] as const;

const createRepository = async (
  ctx: CoreContext,
): Promise<GeneratedIntentCardRepository> => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new GeneratedIntentCardRepository(manager.open("pin"));
};

export const normalizeTitleKey = (title: string): string => makeTitleKey(title);

const sanitizeCard = (card: IntentCard): void => {
  validateEnum("goalBasket", card.goalBasket, VALID_BASKETS);
  rejectDangerousChars("id", card.id);
  rejectDangerousChars("title", card.title);
  rejectDangerousChars("whyNow", card.whyNow);
  rejectDangerousChars("summary", card.summary);
  rejectDangerousChars("primaryAction.label", card.primaryAction.label);
  card.sources.forEach((source, index) => {
    rejectDangerousChars(`sources[${index}]`, source);
  });
  card.agentChain.forEach((agent, index) => {
    rejectDangerousChars(`agentChain[${index}]`, agent);
  });
};

export const recordGeneratedBatch = async (
  ctx: CoreContext,
  input: {
    runId: string;
    generatedAt?: string;
    cards: IntentCard[];
  },
): Promise<GeneratedIntentCardRow[]> => {
  rejectDangerousChars("runId", input.runId);

  const repository = await createRepository(ctx);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  input.cards.forEach(sanitizeCard);

  const rows = await repository.recordBatch({
    runId: input.runId,
    generatedAt,
    cards: input.cards.map((card) => ({
      cardId: card.id,
      intentKey: makeIntentKey(card.goalBasket, card.title),
      goalBasket: card.goalBasket,
      title: card.title,
      titleKey: normalizeTitleKey(card.title),
      whyNow: card.whyNow,
      summary: card.summary,
      primaryActionLabel: card.primaryAction.label,
      sources: card.sources,
      metadata: {
        agentChain: card.agentChain,
        confidence: card.confidence,
        urgency: card.urgency,
        importance: card.importance,
        cardCreatedAt: card.createdAt,
      },
    })),
  });

  await seedGeneratedCards(ctx, {
    generatedAt,
    cards: rows.map((row) => ({
      cardId: row.cardId,
      intentKey: row.intentKey,
      goalBasket: row.goalBasket,
    })),
  });

  return rows;
};

export const listRecentGeneratedCards = async (
  ctx: CoreContext,
  input: {
    limit?: string;
    basket?: string;
    since?: string;
  },
): Promise<GeneratedIntentCardWithThreadContextRow[]> => {
  if (input.basket) {
    validateEnum("basket", input.basket, VALID_BASKETS);
  }

  const repository = await createRepository(ctx);
  const rows = await repository.listRecent({
    limit: parseOptionalInt(input.limit, 10),
    basket: input.basket,
    since: input.since ? parseSinceToISO(input.since) : undefined,
  });
  const threadStateMap = new Map(
    (await listThreadStates(ctx, {
      intentKeys: rows.map((row) => row.intentKey),
    })).map((state) => [state.intentKey, state]),
  );

  return rows.map((row) => {
    const threadState = threadStateMap.get(row.intentKey) ?? buildDefaultThreadState({
      intentKey: row.intentKey,
      goalBasket: row.goalBasket,
    });
    const threadContext: ThreadContext = {
      intentKey: threadState.intentKey,
      latestCardOutcome: threadState.latestCardOutcome,
      hasAnyConfirmedCard: threadState.hasAnyConfirmedCard,
      hasAnyDismissedCard: threadState.hasAnyDismissedCard,
      latestChatDecision: threadState.latestChatDecision,
      latestChatSummary: threadState.latestChatSummary,
      nextAngles: threadState.nextAngles,
      threadDecision: threadState.threadDecision,
    };
    return {
      ...row,
      threadContext,
    };
  });
};

export const getGeneratedCardByCardId = async (
  ctx: CoreContext,
  input: { cardId: string },
): Promise<GeneratedIntentCardRow | null> => {
  rejectDangerousChars("cardId", input.cardId);
  const repository = await createRepository(ctx);
  return repository.getByCardId(input.cardId);
};
