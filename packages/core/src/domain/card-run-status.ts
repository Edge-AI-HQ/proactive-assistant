/**
 * Card execution-run status — parse + UI derivation.
 *
 * `runStatus` (GET /api/cards) mirrors the latest `pai_agent_runs.status` of
 * the card's execution thread, so the UI can render running / needs-input /
 * ready / failed from durable server state instead of in-memory sets (which
 * an app kill wipes — the "yellow spinner card relaunches as untouched" bug).
 *
 * Kept out of domain/cards.ts parseEntries so the parse stays a data
 * concern and the UI mapping is unit-testable on its own.
 */

export type CardRunStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";

const CARD_RUN_STATUSES = new Set<CardRunStatus>([
  "pending",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
]);

export function parseCardRunStatus(value: unknown): CardRunStatus | null {
  return typeof value === "string" && CARD_RUN_STATUSES.has(value as CardRunStatus)
    ? (value as CardRunStatus)
    : null;
}

/** UI status a card's execution state maps onto (subset of CardStatus):
 *  processing = agent working, needs_input = paused on an approval,
 *  ready = agent finished its turn and the result awaits the user's review
 *  (distinct from "done", which only the user's explicit Done action sets). */
export type CardRunUiStatus = "normal" | "processing" | "needs_input" | "ready" | "failed";

export interface DeriveCardUiStatusArgs {
  /** Latest server-side run status of the card's thread (null = never ran). */
  runStatus: CardRunStatus | null;
  /** Latest user feedback action from /api/cards (confirm/modify/... ). */
  latestOutcome: string | null;
  /** Local optimistic "user just kicked an execution" flag (processingIds). */
  optimisticProcessing: boolean;
  /** Local "user opened this card's chat" flag (chattedIds). */
  chatted: boolean;
}

export function deriveCardUiStatus(args: DeriveCardUiStatusArgs): CardRunUiStatus {
  // Engagement gate: the generator fanout pre-runs top cards through the
  // same execution path (source="user"), so a terminal run alone doesn't
  // mean the user ever started the card — without this gate every pre-run
  // card would land on the sphere already wearing a READY badge.
  const engaged =
    args.latestOutcome === "confirm" ||
    args.latestOutcome === "modify" ||
    args.optimisticProcessing ||
    args.chatted;
  if (!engaged) return "normal";
  // Server state wins over the optimistic flag whenever a run exists: the
  // optimistic spinner only bridges the send → run-row-visible gap. (A card
  // whose fanout pre-run already finished must show ready immediately —
  // trusting the optimistic flag there would re-create the eternal spinner.)
  switch (args.runStatus) {
    case "pending":
    case "running":
      return "processing";
    case "awaiting_input":
      return "needs_input";
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
    case "cancelled":
      return "normal";
    default:
      return args.optimisticProcessing ? "processing" : "normal";
  }
}
