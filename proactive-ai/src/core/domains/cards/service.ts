import { GeneratedIntentCardRepository } from "./repository.js";
import type { GeneratedIntentCardRow } from "./schema.js";

import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import type { IntentCard } from "../../types/intent-card.js";
import { makeTitleKey } from "../../../shared/intent-key.js";
import {
  validateEnum,
  parseSinceToISO,
  parseOptionalInt,
  rejectDangerousChars,
} from "../../validation.js";

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

  return repository.recordBatch({
    runId: input.runId,
    generatedAt,
    cards: input.cards.map((card) => ({
      cardId: card.id,
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
};

export const listRecentGeneratedCards = async (
  ctx: CoreContext,
  input: {
    limit?: string;
    basket?: string;
    since?: string;
  },
): Promise<GeneratedIntentCardRow[]> => {
  if (input.basket) {
    validateEnum("basket", input.basket, VALID_BASKETS);
  }

  const repository = await createRepository(ctx);
  return repository.listRecent({
    limit: parseOptionalInt(input.limit, 10),
    basket: input.basket,
    since: input.since ? parseSinceToISO(input.since) : undefined,
  });
};
