import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import { rejectDangerousChars, validateEnum } from "../../validation.js";

import { IntentStateRepository } from "./repository.js";
import type { IntentThreadStateRow } from "./schema.js";

export const VALID_CARD_OUTCOMES = ["confirm", "modify", "dismiss", "snooze", "none"] as const;
export const VALID_CHAT_DECISIONS = ["advance", "refine", "hold", "suppress", "none"] as const;
export const VALID_THREAD_DECISIONS = ["advance", "refine", "hold", "suppress"] as const;

export type CardOutcome = (typeof VALID_CARD_OUTCOMES)[number];
export type ChatDecision = (typeof VALID_CHAT_DECISIONS)[number];
export type ThreadDecision = (typeof VALID_THREAD_DECISIONS)[number];

export interface ThreadState {
  intentKey: string;
  goalBasket: string;
  latestCardId: string | null;
  latestGeneratedAt: string | null;
  latestCardOutcome: CardOutcome;
  hasAnyConfirmedCard: boolean;
  hasAnyDismissedCard: boolean;
  latestChatDecision: ChatDecision;
  latestChatSummary: string | null;
  nextAngles: string[];
  threadDecision: ThreadDecision;
  updatedAt: string;
}

const createRepository = async (ctx: CoreContext): Promise<IntentStateRepository> => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new IntentStateRepository(manager.open("pin"));
};

const DEFAULT_CHAT_DECISION: ChatDecision = "none";
const DEFAULT_CARD_OUTCOME: CardOutcome = "none";
const DEFAULT_THREAD_DECISION: ThreadDecision = "hold";

function toThreadDecision(latestCardOutcome: CardOutcome, latestChatDecision: ChatDecision): ThreadDecision {
  if (latestChatDecision !== "none") return latestChatDecision;
  switch (latestCardOutcome) {
    case "confirm":
      return "advance";
    case "modify":
      return "refine";
    case "dismiss":
      return "suppress";
    case "snooze":
    case "none":
    default:
      return "hold";
  }
}

function asBool(value: unknown): boolean {
  return value === 1 || value === true;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapThreadState(row: IntentThreadStateRow): ThreadState {
  return {
    intentKey: row.intentKey,
    goalBasket: row.goalBasket,
    latestCardId: row.latestCardId ?? null,
    latestGeneratedAt: row.latestGeneratedAt ?? null,
    latestCardOutcome: row.latestCardOutcome as CardOutcome,
    hasAnyConfirmedCard: asBool(row.hasAnyConfirmedCard),
    hasAnyDismissedCard: asBool(row.hasAnyDismissedCard),
    latestChatDecision: row.latestChatDecision as ChatDecision,
    latestChatSummary: row.latestChatSummary ?? null,
    nextAngles: asStringArray(row.nextAngles),
    threadDecision: row.threadDecision as ThreadDecision,
    updatedAt: row.updatedAt,
  };
}

export function buildDefaultThreadState(input: {
  intentKey: string;
  goalBasket?: string | null;
}): ThreadState {
  return {
    intentKey: input.intentKey,
    goalBasket: input.goalBasket ?? "life",
    latestCardId: null,
    latestGeneratedAt: null,
    latestCardOutcome: DEFAULT_CARD_OUTCOME,
    hasAnyConfirmedCard: false,
    hasAnyDismissedCard: false,
    latestChatDecision: DEFAULT_CHAT_DECISION,
    latestChatSummary: null,
    nextAngles: [],
    threadDecision: DEFAULT_THREAD_DECISION,
    updatedAt: "",
  };
}

export const seedGeneratedCards = async (
  ctx: CoreContext,
  input: {
    generatedAt: string;
    cards: Array<{ cardId: string; intentKey: string; goalBasket: string }>;
  },
): Promise<void> => {
  const repository = await createRepository(ctx);
  const now = input.generatedAt;

  for (const card of input.cards) {
    rejectDangerousChars("cardId", card.cardId);
    rejectDangerousChars("intentKey", card.intentKey);

    const currentCard = repository.getCardState(card.cardId);
    repository.upsertCardState({
      cardId: card.cardId,
      intentKey: card.intentKey,
      goalBasket: card.goalBasket,
      latestOutcome: currentCard?.latestOutcome ?? DEFAULT_CARD_OUTCOME,
      outcomeAt: currentCard?.outcomeAt ?? null,
      hasDeepChat: asBool(currentCard?.hasDeepChat),
      latestChatDecision: (currentCard?.latestChatDecision as ChatDecision | undefined) ?? DEFAULT_CHAT_DECISION,
      latestChatSummary: currentCard?.latestChatSummary ?? null,
      nextAngles: asStringArray(currentCard?.nextAngles),
      updatedAt: now,
    });

    const currentThreadRow = repository.getThreadState(card.intentKey);
    const currentThread = currentThreadRow ? mapThreadState(currentThreadRow) : buildDefaultThreadState({
      intentKey: card.intentKey,
      goalBasket: card.goalBasket,
    });

    const latestGeneratedAt = !currentThread.latestGeneratedAt || currentThread.latestGeneratedAt <= now
      ? now
      : currentThread.latestGeneratedAt;
    const latestCardId = !currentThread.latestGeneratedAt || currentThread.latestGeneratedAt <= now
      ? card.cardId
      : currentThread.latestCardId;

    repository.upsertThreadState({
      intentKey: card.intentKey,
      goalBasket: card.goalBasket,
      latestCardId,
      latestGeneratedAt,
      latestCardOutcome: currentThread.latestCardOutcome,
      hasAnyConfirmedCard: currentThread.hasAnyConfirmedCard,
      hasAnyDismissedCard: currentThread.hasAnyDismissedCard,
      latestChatDecision: currentThread.latestChatDecision,
      latestChatSummary: currentThread.latestChatSummary,
      nextAngles: currentThread.nextAngles,
      threadDecision: currentThread.threadDecision,
      updatedAt: now,
    });
  }
};

export const applyCardOutcome = async (
  ctx: CoreContext,
  input: {
    cardId: string;
    intentKey: string;
    goalBasket: string;
    outcome: Exclude<CardOutcome, "none">;
    at?: string;
  },
): Promise<void> => {
  validateEnum("outcome", input.outcome, VALID_CARD_OUTCOMES.filter((value) => value !== "none"));
  const repository = await createRepository(ctx);
  const now = input.at ?? new Date().toISOString();

  const currentCard = repository.getCardState(input.cardId);
  repository.upsertCardState({
    cardId: input.cardId,
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestOutcome: input.outcome,
    outcomeAt: now,
    hasDeepChat: asBool(currentCard?.hasDeepChat),
    latestChatDecision: (currentCard?.latestChatDecision as ChatDecision | undefined) ?? DEFAULT_CHAT_DECISION,
    latestChatSummary: currentCard?.latestChatSummary ?? null,
    nextAngles: asStringArray(currentCard?.nextAngles),
    updatedAt: now,
  });

  const currentThreadRow = repository.getThreadState(input.intentKey);
  const currentThread = currentThreadRow ? mapThreadState(currentThreadRow) : buildDefaultThreadState({
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
  });

  const nextThread: ThreadState = {
    ...currentThread,
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestCardId: input.cardId,
    latestCardOutcome: input.outcome,
    hasAnyConfirmedCard: currentThread.hasAnyConfirmedCard || input.outcome === "confirm",
    hasAnyDismissedCard: currentThread.hasAnyDismissedCard || input.outcome === "dismiss",
    threadDecision: toThreadDecision(input.outcome, currentThread.latestChatDecision),
    updatedAt: now,
  };

  repository.upsertThreadState({
    ...nextThread,
    updatedAt: now,
  });
};

export const applyChatDecision = async (
  ctx: CoreContext,
  input: {
    cardId: string;
    intentKey: string;
    goalBasket: string;
    decision: Exclude<ChatDecision, "none">;
    summary: string;
    nextAngles: string[];
    at?: string;
  },
): Promise<void> => {
  validateEnum("decision", input.decision, VALID_CHAT_DECISIONS.filter((value) => value !== "none"));
  rejectDangerousChars("summary", input.summary);

  const repository = await createRepository(ctx);
  const now = input.at ?? new Date().toISOString();

  const currentCard = repository.getCardState(input.cardId);
  repository.upsertCardState({
    cardId: input.cardId,
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestOutcome: (currentCard?.latestOutcome as CardOutcome | undefined) ?? DEFAULT_CARD_OUTCOME,
    outcomeAt: currentCard?.outcomeAt ?? null,
    hasDeepChat: true,
    latestChatDecision: input.decision,
    latestChatSummary: input.summary,
    nextAngles: input.nextAngles,
    updatedAt: now,
  });

  const currentThreadRow = repository.getThreadState(input.intentKey);
  const currentThread = currentThreadRow ? mapThreadState(currentThreadRow) : buildDefaultThreadState({
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
  });

  repository.upsertThreadState({
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestCardId: currentThread.latestCardId ?? input.cardId,
    latestGeneratedAt: currentThread.latestGeneratedAt,
    latestCardOutcome: currentThread.latestCardOutcome,
    hasAnyConfirmedCard: currentThread.hasAnyConfirmedCard,
    hasAnyDismissedCard: currentThread.hasAnyDismissedCard,
    latestChatDecision: input.decision,
    latestChatSummary: input.summary,
    nextAngles: input.nextAngles,
    threadDecision: input.decision,
    updatedAt: now,
  });
};

export const listThreadStates = async (
  ctx: CoreContext,
  input: { intentKeys: string[] },
): Promise<ThreadState[]> => {
  const repository = await createRepository(ctx);
  return repository.listThreadStates(input.intentKeys).map(mapThreadState);
};
