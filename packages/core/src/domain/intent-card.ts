/**
 * Core types for Intent Card generation pipeline.
 * Inlined from proactive-ai/src/core/types/intent-card.ts for cloud frontend.
 */

export type GoalBasket = 'work' | 'health' | 'family' | 'wealth' | 'growth' | 'life';

export interface IntentCardAction {
  label: string;
  type: 'confirm' | 'modify' | 'snooze' | 'dismiss';
  /** Full task instruction for the Card Execution agent on Confirm — distinct
   *  from the short button `label`. Optional: older cards omit it and callers
   *  fall back to `label`. */
  agentPrompt?: string;
}

export interface ReasoningStep {
  label: string;
  detail: string;
}

export interface IntentCard {
  id: string;
  intentKey?: string;
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
  /** Deterministic user-facing app slugs (gmail / gcal / web / device / …)
   *  stamped by the backend; legacy cards get them derived client-side
   *  from the audit citations in `sources`. Always present (possibly []). */
  sourceApps: string[];
  /** LLM-written "How I reasoned" steps, audited against sources[] by the
   *  evaluator. Empty for legacy / reminder cards — UI hides the section. */
  reasoningSteps: ReasoningStep[];
  agentChain: string[];
  createdAt: string;
  /** Provenance for cards produced by a user's scheduled generator task —
   *  drives the lightweight "Scheduled · <label>" marker. Absent on
   *  manual / auto-generated cards. */
  sourceKind?: string;
  sourceLabel?: string;
  /** Explicit card type stamped at creation (server-side). "reminder" =
   *  acknowledge-only nudge card (zero-LLM reminder subsystem) — the drawer
   *  renders Dismiss/Chat/Done instead of the execute flow. Absent on
   *  generator cards. Prefer `isReminderCard` (domain/reminder-card.ts) over
   *  reading this directly — it also covers older cards via the id prefix. */
  cardKind?: string;
  /** The owning pai_scheduled_tasks id for reminder cards — rides into
   *  card_context so the chat agent can edit/delete THIS reminder's
   *  schedule with the scheduled_generator_* tools. */
  scheduleTaskId?: string;
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

export type SupportedGenerationLanguage = 'en' | 'zh-Hans' | 'ja' | 'ko' | 'es' | 'fr' | 'de' | 'pt';

export const GENERATION_LANGUAGE_OPTIONS: { value: SupportedGenerationLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: 'Simplified Chinese' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
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

const CITATION_TOKEN_TO_APP: Record<string, string> = {
  signal: "device",
  memory: "memory",
  gmail: "gmail",
  gcal: "gcal",
  world: "web",
  profile: "profile",
  goal: "goal",
  preference: "preference",
};

const CITATION_PREFIX_RE = /^\s*([a-z0-9_-]+)(?:\s+[a-z0-9_-]+)*\s+id=/i;

/** Mirror of the backend's derive_source_apps (generator.py) for cards
 *  persisted before the backend stamped sourceApps. Unknown shapes are
 *  dropped so raw audit strings never reach the UI. */
export function deriveSourceAppsFromCitations(sources: string[]): string[] {
  const apps: string[] = [];
  for (const citation of sources) {
    const match = CITATION_PREFIX_RE.exec(citation);
    if (!match) continue;
    const token = match[1].toLowerCase();
    const app = CITATION_TOKEN_TO_APP[token] ?? token;
    if (!apps.includes(app)) apps.push(app);
  }
  return apps;
}

function normalizeReasoningSteps(value: unknown): ReasoningStep[] {
  if (!Array.isArray(value)) return [];
  const steps: ReasoningStep[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const detail = typeof item.detail === "string" ? item.detail.trim() : "";
    if (!label || !detail) continue;
    steps.push({ label, detail });
  }
  return steps;
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
  const agentPrompt = typeof value.agentPrompt === "string" && value.agentPrompt.trim().length > 0
    ? value.agentPrompt.trim()
    : fallback.agentPrompt;
  return { label, type, ...(agentPrompt ? { agentPrompt } : {}) };
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
  const sources = toStringArray(record.sources);
  const sourceApps = toStringArray(record.sourceApps);

  return {
    id: typeof record.id === "string" && record.id.trim().length > 0
      ? record.id
      : `card-${Math.random().toString(36).slice(2, 10)}`,
    ...(typeof record.intentKey === "string" && record.intentKey.trim().length > 0
      ? { intentKey: record.intentKey.trim() }
      : typeof record.intent_key === "string" && record.intent_key.trim().length > 0
        ? { intentKey: record.intent_key.trim() }
        : {}),
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
    sources,
    sourceApps: sourceApps.length > 0 ? sourceApps : deriveSourceAppsFromCitations(sources),
    reasoningSteps: normalizeReasoningSteps(record.reasoningSteps),
    agentChain: toStringArray(record.agentChain),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    ...(typeof record.sourceKind === "string" && record.sourceKind.trim().length > 0
      ? { sourceKind: record.sourceKind.trim() }
      : {}),
    ...(typeof record.sourceLabel === "string" && record.sourceLabel.trim().length > 0
      ? { sourceLabel: record.sourceLabel.trim() }
      : {}),
    ...(typeof record.cardKind === "string" && record.cardKind.trim().length > 0
      ? { cardKind: record.cardKind.trim() }
      : {}),
    ...(typeof record.scheduleTaskId === "string" && record.scheduleTaskId.trim().length > 0
      ? { scheduleTaskId: record.scheduleTaskId.trim() }
      : {}),
  };
}

export function normalizeIntentCards(cards: unknown): IntentCard[] {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter(isRecord)
    .map((card) => normalizeIntentCard(card));
}
