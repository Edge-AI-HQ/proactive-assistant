/**
 * Cards 域：/cards 响应的解析与 outcome 语义（从 hooks/useCards.ts 提纯）。
 * 纯 TS，三端共用。
 */
import { parseCardRunStatus, type CardRunStatus } from "./card-run-status";
import { normalizeIntentCard, type IntentCard } from "./intent-card";

export interface CardScore {
  overall: number;
  pass: boolean;
}

export type CardOutcome = "confirm" | "modify" | "dismiss" | "snooze" | "complete";

const CARD_OUTCOMES = new Set<CardOutcome>([
  "confirm",
  "modify",
  "dismiss",
  "snooze",
  "complete",
]);

export function parseCardOutcome(value: unknown): CardOutcome | null {
  return typeof value === "string" && CARD_OUTCOMES.has(value as CardOutcome)
    ? value as CardOutcome
    : null;
}

export function isCompletedCardOutcome(outcome: CardOutcome | null | undefined): boolean {
  return outcome === "complete";
}

export function isHiddenCardOutcome(outcome: CardOutcome | null | undefined): boolean {
  return outcome === "complete" || outcome === "dismiss" || outcome === "snooze";
}

export interface VisibleCardEntry {
  card: IntentCard;
  /** GENERATION pipeline run that produced this card (pai_pipeline_runs) —
   *  unrelated to runStatus, which tracks the card's EXECUTION thread. */
  runId: string;
  runCompletedAt: string;
  score: CardScore | null;
  latestOutcome: CardOutcome | null;
  outcomeAt: string | null;
  /** Latest execution-run status of the card's thread (pai_agent_runs);
   *  null = never ran. Survives app relaunch, unlike optimistic local sets. */
  runStatus: CardRunStatus | null;
}

interface CardsResponseEntry {
  card?: unknown;
  runId?: unknown;
  runCompletedAt?: unknown;
  score?: unknown;
  latestOutcome?: unknown;
  outcomeAt?: unknown;
  runStatus?: unknown;
}

function parseScore(value: unknown): CardScore | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.overall !== "number" || typeof r.pass !== "boolean") return null;
  return { overall: r.overall, pass: r.pass };
}

export function parseEntries(payload: unknown): VisibleCardEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const list = (payload as { cards?: unknown }).cards;
  if (!Array.isArray(list)) return [];
  const out: VisibleCardEntry[] = [];
  for (const raw of list as CardsResponseEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.runId !== "string" || typeof raw.runCompletedAt !== "string") continue;
    out.push({
      card: normalizeIntentCard(raw.card),
      runId: raw.runId,
      runCompletedAt: raw.runCompletedAt,
      score: parseScore(raw.score),
      latestOutcome: parseCardOutcome(raw.latestOutcome),
      outcomeAt: typeof raw.outcomeAt === "string" ? raw.outcomeAt : null,
      runStatus: parseCardRunStatus(raw.runStatus),
    });
  }
  return out;
}
