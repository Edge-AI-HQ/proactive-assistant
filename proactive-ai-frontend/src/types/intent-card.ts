/**
 * Core types for Intent Card generation pipeline.
 * Inlined from proactive-ai/src/core/types/intent-card.ts for cloud frontend.
 */

export type GoalBasket = 'work' | 'health' | 'family' | 'wealth' | 'growth' | 'life';

export interface IntentCardAction {
  label: string;
  type: 'confirm' | 'modify' | 'snooze' | 'dismiss';
}

export interface IntentCard {
  id: string;
  goalBasket: GoalBasket;
  title: string;
  whyNow: string;
  summary: string;
  primaryAction: IntentCardAction;
  secondaryActions: IntentCardAction[];
  confidence: number;
  urgency: number;
  importance: number;
  sources: string[];
  agentChain: string[];
  createdAt: string;
}

export interface EvaluationScore {
  cardId: string;
  overall: number;
  dimensions: {
    relevance: number;
    actionability: number;
    whyNowClarity: number;
    novelty: number;
    decisionCompression: number;
  };
  feedback: string;
  pass: boolean;
}

export interface EvaluatorOutput {
  evaluations: EvaluationScore[];
  bestCards: IntentCard[];
  iterationFeedback: string;
}

export type SupportedGenerationLanguage = 'en' | 'zh' | 'ja' | 'ko' | 'es' | 'fr' | 'de';

export const GENERATION_LANGUAGE_OPTIONS: { value: SupportedGenerationLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

const VALID_GOAL_BASKETS = new Set<GoalBasket>([
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
]);

const VALID_ACTION_TYPES = new Set<IntentCardAction["type"]>([
  "confirm",
  "modify",
  "snooze",
  "dismiss",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeAction(
  value: unknown,
  fallback: IntentCardAction,
): IntentCardAction {
  if (!isRecord(value)) return fallback;
  const label = typeof value.label === "string" && value.label.trim().length > 0
    ? value.label.trim()
    : fallback.label;
  const type = typeof value.type === "string" && VALID_ACTION_TYPES.has(value.type as IntentCardAction["type"])
    ? value.type as IntentCardAction["type"]
    : fallback.type;
  return { label, type };
}

export function normalizeIntentCard(card: unknown): IntentCard {
  const record = isRecord(card) ? card : {};
  const whyNow = typeof record.whyNow === "string" ? record.whyNow.trim() : "";
  const summary = typeof record.summary === "string" && record.summary.trim().length > 0
    ? record.summary.trim()
    : whyNow;
  const goalBasket = typeof record.goalBasket === "string" && VALID_GOAL_BASKETS.has(record.goalBasket as GoalBasket)
    ? record.goalBasket as GoalBasket
    : "life";

  return {
    id: typeof record.id === "string" && record.id.trim().length > 0
      ? record.id
      : `card-${Math.random().toString(36).slice(2, 10)}`,
    goalBasket,
    title: typeof record.title === "string" && record.title.trim().length > 0
      ? record.title.trim()
      : "Untitled card",
    whyNow,
    summary,
    primaryAction: normalizeAction(record.primaryAction, {
      label: "Review this card",
      type: "modify",
    }),
    secondaryActions: Array.isArray(record.secondaryActions)
      ? record.secondaryActions
          .filter(isRecord)
          .map((action) =>
            normalizeAction(action, {
              label: "Later",
              type: "snooze",
            }),
          )
      : [],
    confidence: toFiniteNumber(record.confidence, 0.5),
    urgency: toFiniteNumber(record.urgency, 0.5),
    importance: toFiniteNumber(record.importance, 0.5),
    sources: toStringArray(record.sources),
    agentChain: toStringArray(record.agentChain),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
  };
}

export function normalizeIntentCards(cards: unknown): IntentCard[] {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter(isRecord)
    .map((card) => normalizeIntentCard(card));
}
