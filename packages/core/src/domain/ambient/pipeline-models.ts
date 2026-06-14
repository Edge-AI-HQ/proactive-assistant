// Pure subset of the ambient timeline model bridge (lifted from web
// services/ambient/timeline/models.ts). Types, LLM-output normalization /
// sanitization, the AmbientTimelineModelBridge contract and the no-op bridge —
// all platform-free. The native bridge (Capacitor @pin/capacitor-ambient-ai +
// localStorage model selection) stays in each app and imports these helpers.
import type { AmbientSummaryContext } from "./summary-context";
import type {
  AmbientActionBasket,
  AmbientCandidateWindow,
  AmbientTimelineAction,
  AmbientTimelineEvent,
} from "./types";

const ACTION_LABEL_MAX = 24;
const ACTION_GOAL_MAX = 100;
const ACTION_BASKETS: ReadonlySet<AmbientActionBasket> = new Set([
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
]);

const TIMELINE_BATCH_MAX_WINDOWS = 1;
const TIMELINE_BATCH_WINDOW_CONTEXT_CHARS = 480;
const TIMELINE_SINGLE_WINDOW_CONTEXT_CHARS = 700;
const TIMELINE_CONTEXT_ELLIPSIS = "…";

export interface AmbientTimelineEventDraft {
  eventType: AmbientTimelineEvent["eventType"];
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: AmbientTimelineEvent["confidenceLabel"];
  salientFacts: string[];
  actionCandidates?: AmbientTimelineAction[];
  memoryCandidates?: string[];
  possibleCardTrigger?: {
    title: string;
    reason: string;
  };
}

export interface AmbientWindowSummary {
  summary: string;
  confidence: number;
  salientFacts: string[];
}

export type AmbientTimelineGenerationErrorCode =
  | "no_selected_model"
  | "model_not_found"
  | "model_not_llm"
  | "model_not_present"
  | "verify_required"
  | "native_unavailable"
  | "generation_timeout"
  | "invalid_json"
  | "invalid_shape"
  | "chat_template_unavailable"
  | "generation_failed";

const PLACEHOLDER_ECHO_TOKENS = new Set([
  "title",
  "short title",
  "<title>",
  "<title_here>",
  "<short title>",
  "summary",
  "<summary>",
  "<summary_here>",
  "one sentence",
  "<one sentence>",
  "specific title",
  "specific title from context",
  "specific summary",
  "specific summary from context",
  "title from context",
  "summary from context",
  "iso",
  "<iso>",
  "<startedat>",
  "<started_at_here>",
  "<endedat>",
  "<ended_at_here>",
  "<occurredat>",
  "<occurred_at_here>",
  "eventtype",
  "<eventtype>",
  "<window_id>",
  "<window_id_here>",
  "window_id",
  "<window_type_here>",
  "<source_types_here>",
  "<context_here>",
  "<tag_here>",
  "<fact_here>",
  "<low_medium_or_high>",
  "<float_0_to_1>",
  "<conversation|meeting|focus|social|other>",
  "<certain|probable|uncertain>",
]);

const PLACEHOLDER_ANGLE_PATTERN = /^<[^>]{1,80}>$/;

const EXAMPLE_ECHO_PHRASES = [
  "alice flagged",
  "bob owns",
  "bob took the action",
  "apns entitlement",
  "testflight 84",
  "push notification regression",
  "roll back the apns",
  "rolling back the apns",
];

function isPlaceholderEcho(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_ECHO_TOKENS.has(lower)) return true;
  if (PLACEHOLDER_ANGLE_PATTERN.test(trimmed)) return true;
  return EXAMPLE_ECHO_PHRASES.some((phrase) => lower.includes(phrase));
}

const EVIDENCE_LABEL_PATTERN = /\b(transcript segment|sound context|motion context|location context|place context|visit context)\s*:\s*/gi;

function stripEvidenceLabels(value: string): string {
  return value.replace(EVIDENCE_LABEL_PATTERN, "").replace(/\s+/g, " ").trim();
}

function titleHasEvidenceLabel(value: string): boolean {
  EVIDENCE_LABEL_PATTERN.lastIndex = 0;
  return EVIDENCE_LABEL_PATTERN.test(value);
}

function deriveTitleFromContext(context: string | undefined, max = 30): string | null {
  if (!context) return null;
  const stripped = stripEvidenceLabels(context);
  if (!stripped) return null;
  const punctuationSplit = stripped.split(/[。．\.！\!？\?；;\n]/).map((part) => part.trim()).filter(Boolean);
  const head = punctuationSplit[0] ?? stripped;
  if (head.length <= max) return head;
  return head.slice(0, max - 1).trimEnd() + "…";
}

function normalizeAct(
  raw: unknown,
  context: { title: string; summary: string },
): AmbientTimelineAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const rawLabel = typeof row.l === "string"
    ? row.l
    : typeof row.label === "string" ? row.label : "";
  const rawGoal = typeof row.g === "string"
    ? row.g
    : typeof row.goal === "string" ? row.goal : "";
  const label = rawLabel.trim();
  const goal = rawGoal.trim();
  if (!label || !goal) return null;
  if (isPlaceholderEcho(label) || isPlaceholderEcho(goal)) return null;
  EVIDENCE_LABEL_PATTERN.lastIndex = 0;
  if (EVIDENCE_LABEL_PATTERN.test(label)) return null;
  EVIDENCE_LABEL_PATTERN.lastIndex = 0;
  if (EVIDENCE_LABEL_PATTERN.test(goal)) return null;
  if (label === goal) return null;
  if (label === context.title.trim()) return null;
  if (goal === context.summary.trim()) return null;
  const trimmedLabel = label.length <= ACTION_LABEL_MAX
    ? label
    : label.slice(0, ACTION_LABEL_MAX - 1).trimEnd() + "…";
  const trimmedGoal = goal.length <= ACTION_GOAL_MAX
    ? goal
    : goal.slice(0, ACTION_GOAL_MAX - 1).trimEnd() + "…";
  const rawBasket = typeof row.b === "string"
    ? row.b
    : typeof row.goalBasket === "string" ? row.goalBasket : "";
  const basket = rawBasket && ACTION_BASKETS.has(rawBasket as AmbientActionBasket)
    ? (rawBasket as AmbientActionBasket)
    : undefined;
  return {
    label: trimmedLabel,
    goal: trimmedGoal,
    ...(basket ? { goalBasket: basket } : {}),
  };
}

function sanitizeLlmTitle(
  rawTitle: string,
  summary: string,
  context: string | undefined,
  max = 30,
): string {
  const stripped = stripEvidenceLabels(rawTitle).trim();
  const looksEqualToSummary = stripped.length > 0 && stripped === summary.trim();
  const tooLong = stripped.length > max;
  const empty = stripped.length === 0;
  const hadLabel = titleHasEvidenceLabel(rawTitle);
  if (!empty && !looksEqualToSummary && !tooLong && !hadLabel) {
    return stripped;
  }
  const derived = deriveTitleFromContext(context, max);
  if (derived) return derived;
  if (!empty && !looksEqualToSummary) {
    return tooLong ? stripped.slice(0, max - 1).trimEnd() + "…" : stripped;
  }
  return "Voice note";
}

export type AmbientTimelineGenerationResult =
  | { ok: true; draft: AmbientTimelineEventDraft }
  | { ok: false; errorCode: AmbientTimelineGenerationErrorCode; errorMessage?: string };

export interface AmbientTimelineBatchGenerationInput {
  windows: AmbientCandidateWindow[];
  recentLlmCards?: AmbientTimelineEvent[];
  ruleContext?: AmbientTimelineEvent[];
}

export type LlmTimelineDecision =
  | {
      action: "create";
      title: string;
      summary: string;
      importance: "low" | "medium" | "high";
      occurredAt: string;
      sourceWindowIds: string[];
      actionCandidates?: AmbientTimelineAction[];
    }
  | {
      action: "update";
      eventId: string;
      title?: string;
      summary: string;
      sourceWindowIds: string[];
    }
  | {
      action: "skip";
      reason: string;
      sourceWindowIds: string[];
    };

export interface LlmTimelineBatchDecision {
  decisions: LlmTimelineDecision[];
}

export type AmbientTimelineBatchGenerationResult =
  | { ok: true; batch: LlmTimelineBatchDecision }
  | { ok: false; errorCode: AmbientTimelineGenerationErrorCode; errorMessage?: string };

export interface AmbientTimelineModelBridge {
  summarizeWindow(window: AmbientCandidateWindow): Promise<AmbientWindowSummary | null>;
  generateTimelineBatchDecision?(
    input: AmbientTimelineBatchGenerationInput,
  ): Promise<AmbientTimelineBatchGenerationResult>;
  generateTimelineEvent(
    window: AmbientCandidateWindow,
  ): Promise<AmbientTimelineGenerationResult>;
  generateAmbientSummaryEvent?(
    context: AmbientSummaryContext,
  ): Promise<{ ok: true; draft: AmbientTimelineEventDraft; modelId?: string } | { ok: false; errorCode: AmbientTimelineGenerationErrorCode; errorMessage?: string }>;
}

const EVENT_TYPES: AmbientTimelineEvent["eventType"][] = [
  "morning",
  "visit",
  "transition",
  "conversation",
  "meeting",
  "focus",
  "workout",
  "health",
  "social",
  "other",
];

export class NoopAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineBatchDecision(): Promise<AmbientTimelineBatchGenerationResult> {
    return { ok: false, errorCode: "native_unavailable" };
  }

  async generateTimelineEvent(): Promise<AmbientTimelineGenerationResult> {
    return { ok: false, errorCode: "native_unavailable" };
  }

  async generateAmbientSummaryEvent(): Promise<{ ok: false; errorCode: AmbientTimelineGenerationErrorCode }> {
    return { ok: false, errorCode: "native_unavailable" };
  }
}

export function modelBatchPayload(input: AmbientTimelineBatchGenerationInput): Record<string, unknown> {
  return {
    schemaVersion: "ambient_timeline_batch.v1",
    windows: input.windows
      .slice(0, TIMELINE_BATCH_MAX_WINDOWS)
      .map((window) => modelWindowPayload(window, TIMELINE_BATCH_WINDOW_CONTEXT_CHARS)),
    recentLlmCards: (input.recentLlmCards ?? []).slice(0, 2).map(modelCardPayload),
    ruleContext: (input.ruleContext ?? []).slice(0, 2).map(modelCardPayload),
  };
}

function modelCardPayload(event: AmbientTimelineEvent): Record<string, unknown> {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    title: event.title,
    summary: shortPlainText(event.summary, 220),
    sourceWindowIds: event.sourceWindowIds ?? [],
  };
}

export function normalizeBatchDecision(
  value: unknown,
  input: AmbientTimelineBatchGenerationInput,
): LlmTimelineBatchDecision | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.decisions)) return null;
  const decisions = row.decisions.map((decision) => normalizeDecision(decision, input));
  if (decisions.some((decision) => decision === null)) return null;
  const typed = decisions as LlmTimelineDecision[];
  return batchCoversWindowsOnce(typed, input) ? { decisions: typed } : null;
}

function normalizeDecision(
  value: unknown,
  input: AmbientTimelineBatchGenerationInput,
): LlmTimelineDecision | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const action = typeof row.action === "string" ? row.action : row.a;
  const expectedIds = input.windows.map((window) => window.id);
  const reportedIds = stringArray(row.sourceWindowIds ?? row.w);
  const validReportedIds = reportedIds.filter((id) => expectedIds.includes(id));
  const sourceWindowIds = validReportedIds.length > 0
    ? validReportedIds
    : (expectedIds.length === 1 ? expectedIds : []);
  if (sourceWindowIds.length === 0) return null;
  const primaryWindow = input.windows.find((window) => window.id === sourceWindowIds[0]);
  if (action === "create") {
    const rawTitle = shortText(row.title ?? row.t, 120);
    const summary = shortText(row.summary ?? row.s, 180);
    if (!rawTitle || !summary) return null;
    if (isPlaceholderEcho(rawTitle) || isPlaceholderEcho(summary)) return null;
    const title = sanitizeLlmTitle(rawTitle, summary, primaryWindow?.compactContext, 30);
    const rawImportance = row.importance ?? row.i;
    const importance: "low" | "medium" | "high" = isImportance(rawImportance) ? rawImportance : "medium";
    const reportedOccurredAt = shortPlainText(row.occurredAt, 64);
    const occurredAtCandidate = reportedOccurredAt && !isPlaceholderEcho(reportedOccurredAt)
      && Number.isFinite(Date.parse(reportedOccurredAt))
      ? reportedOccurredAt
      : null;
    const occurredAt = occurredAtCandidate
      ?? shortPlainText(primaryWindow?.startedAt, 64);
    if (!occurredAt) return null;
    const action = normalizeAct(row.act ?? row.actionCandidate, { title, summary });
    return {
      action: "create",
      title,
      summary,
      importance,
      occurredAt,
      sourceWindowIds,
      ...(action ? { actionCandidates: [action] } : {}),
    };
  }
  if (action === "update") {
    const eventId = shortPlainText(row.eventId ?? row.e, 128);
    const summary = shortText(row.summary ?? row.s, 180);
    const title = shortText(row.title ?? row.t, 60) ?? undefined;
    if (!eventId || !summary || isPlaceholderModelText(summary) || (title && isPlaceholderModelText(title))) return null;
    return { action: "update", eventId, title, summary, sourceWindowIds };
  }
  if (action === "skip") {
    const reason = shortText(row.reason ?? row.r, 120) ?? "low_value";
    return { action: "skip", reason, sourceWindowIds };
  }
  return null;
}

function batchCoversWindowsOnce(
  decisions: LlmTimelineDecision[],
  input: AmbientTimelineBatchGenerationInput,
): boolean {
  const expected = new Set(input.windows.map((window) => window.id));
  const seen = new Set<string>();
  const recentIds = new Set((input.recentLlmCards ?? []).map((event) => event.id));
  for (const decision of decisions) {
    if (decision.action === "update" && !recentIds.has(decision.eventId)) return false;
    for (const id of decision.sourceWindowIds) {
      if (!expected.has(id) || seen.has(id)) return false;
      seen.add(id);
    }
  }
  return seen.size === expected.size;
}

export function importanceFromConfidence(confidence: number): "low" | "medium" | "high" {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

function isImportance(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function shortPlainText(value: unknown, max = 220): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1).trimEnd() + "…";
}

export function modelWindowPayload(
  window: AmbientCandidateWindow,
  maxContextChars = TIMELINE_SINGLE_WINDOW_CONTEXT_CHARS,
): Record<string, unknown> {
  return {
    id: window.id,
    localDate: window.localDate,
    timezone: window.timezone,
    windowType: window.windowType,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
    sourceTypes: window.sourceTypes.slice(0, 4),
    deviceLabels: window.deviceLabels.slice(0, 3),
    compactContext: truncateContext(window.compactContext, maxContextChars),
    privacyHint: window.privacyHint,
    confidenceHint: window.confidenceHint,
    salienceHint: window.salienceHint,
    schemaVersion: "ambient_candidate_window.v1",
  };
}

export function normalizeDraft(value: unknown, window?: AmbientCandidateWindow): AmbientTimelineEventDraft | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const eventType = EVENT_TYPES.includes(row.eventType as AmbientTimelineEvent["eventType"])
    ? row.eventType as AmbientTimelineEvent["eventType"]
    : "other";
  const rawTitle = shortText(row.title, 120);
  const summary = shortText(row.summary, 220);
  if (!rawTitle || !summary) return null;
  if (isPlaceholderEcho(rawTitle) || isPlaceholderEcho(summary)) return null;
  const title = sanitizeLlmTitle(rawTitle, summary, window?.compactContext, 30);
  const confidence = clamp01(typeof row.confidence === "number" ? row.confidence : 0.5);
  const confidenceLabel = row.confidenceLabel === "certain" || row.confidenceLabel === "uncertain"
    ? row.confidenceLabel
    : confidence >= 0.65 ? "certain" : "uncertain";
  return {
    eventType,
    title,
    summary,
    tags: stringArray(row.tags).map((tag) => tag.slice(0, 32)).slice(0, 6),
    confidence,
    confidenceLabel,
    salientFacts: stringArray(row.salientFacts).slice(0, 6),
  };
}

function truncateContext(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - TIMELINE_CONTEXT_ELLIPSIS.length)).trimEnd() + TIMELINE_CONTEXT_ELLIPSIS;
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1).trimEnd() + "…";
}

function isPlaceholderModelText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return [
    "title",
    "short title",
    "summary",
    "one sentence",
    "iso",
  ].includes(normalized);
}

function validIso(value: string | null): string | null {
  if (!value || isPlaceholderModelText(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function normalizeErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof err === "string" && err.trim()) return err.trim();
  return undefined;
}

export function normalizeErrorCode(err: unknown): AmbientTimelineGenerationErrorCode {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (isGenerationErrorCode(code)) return code;
  }
  return "generation_failed";
}

function isGenerationErrorCode(value: unknown): value is AmbientTimelineGenerationErrorCode {
  return typeof value === "string" && [
    "no_selected_model",
    "model_not_found",
    "model_not_llm",
    "model_not_present",
    "verify_required",
    "native_unavailable",
    "generation_timeout",
    "invalid_json",
    "invalid_shape",
    "chat_template_unavailable",
    "generation_failed",
  ].includes(value);
}
