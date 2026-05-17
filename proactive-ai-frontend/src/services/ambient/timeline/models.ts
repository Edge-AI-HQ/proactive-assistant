import { getSelectedAmbientSummaryModelId } from "../models-selection";
import type { AmbientCandidateWindow, AmbientTimelineEvent } from "./types";

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
  actionCandidates?: string[];
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
  | "generation_failed";

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
}

interface NativeModelProfile {
  id: string;
  kind: string;
}

interface NativeModelStatus {
  id: string;
  state: string;
  lastVerifyResult?: string;
}

interface NativeModelsApi {
  list(): Promise<{ profiles: NativeModelProfile[]; statuses: NativeModelStatus[] }>;
  verifyModel(options: { id: string }): Promise<{ id: string; ok: boolean }>;
  generateTimelineEvent(options: {
    modelId: string;
    window: Record<string, unknown>;
  }): Promise<unknown>;
  generateTimelineBatchDecision?(options: {
    modelId: string;
    batch: Record<string, unknown>;
  }): Promise<unknown>;
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

export function createAmbientTimelineModelBridge(): AmbientTimelineModelBridge {
  return new NativeAmbientTimelineModelBridge();
}

class NativeAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineBatchDecision(
    input: AmbientTimelineBatchGenerationInput,
  ): Promise<AmbientTimelineBatchGenerationResult> {
    const modelId = getSelectedAmbientSummaryModelId();
    if (!modelId) return { ok: false, errorCode: "no_selected_model" };
    let api: NativeModelsApi;
    try {
      api = await loadNativeModelsApi();
    } catch {
      return { ok: false, errorCode: "native_unavailable" };
    }
    const ready = await selectedModelReadiness(api, modelId);
    if (!ready.ok) return ready;
    if (!api.generateTimelineBatchDecision) {
      const decisions: LlmTimelineDecision[] = [];
      for (const window of input.windows) {
        const result = await this.generateTimelineEvent(window);
        if (!result.ok) return result;
        decisions.push({
          action: "create",
          title: result.draft.title,
          summary: result.draft.summary,
          importance: importanceFromConfidence(result.draft.confidence),
          occurredAt: window.startedAt,
          sourceWindowIds: [window.id],
        });
      }
      return { ok: true, batch: { decisions } };
    }
    try {
      const value = await api.generateTimelineBatchDecision({
        modelId,
        batch: modelBatchPayload(input),
      });
      const batch = normalizeBatchDecision(value, input);
      return batch
        ? { ok: true, batch }
        : { ok: false, errorCode: "invalid_shape" };
    } catch (err) {
      return { ok: false, errorCode: normalizeErrorCode(err), errorMessage: normalizeErrorMessage(err) };
    }
  }

  async generateTimelineEvent(
    window: AmbientCandidateWindow,
  ): Promise<AmbientTimelineGenerationResult> {
    const modelId = getSelectedAmbientSummaryModelId();
    if (!modelId) return { ok: false, errorCode: "no_selected_model" };
    let api: NativeModelsApi;
    try {
      api = await loadNativeModelsApi();
    } catch {
      return { ok: false, errorCode: "native_unavailable" };
    }
    const ready = await selectedModelReadiness(api, modelId);
    if (!ready.ok) return ready;
    try {
      const value = await api.generateTimelineEvent({
        modelId,
        window: modelWindowPayload(window),
      });
      const draft = normalizeDraft(value);
      return draft
        ? { ok: true, draft }
        : { ok: false, errorCode: "invalid_shape" };
    } catch (err) {
      return { ok: false, errorCode: normalizeErrorCode(err), errorMessage: normalizeErrorMessage(err) };
    }
  }
}

class NoopAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineBatchDecision(): Promise<AmbientTimelineBatchGenerationResult> {
    return { ok: false, errorCode: "native_unavailable" };
  }

  async generateTimelineEvent(): Promise<AmbientTimelineGenerationResult> {
    return { ok: false, errorCode: "native_unavailable" };
  }
}

export const ambientTimelineModels: AmbientTimelineModelBridge =
  createAmbientTimelineModelBridge();

async function loadNativeModelsApi(): Promise<NativeModelsApi> {
  const mod = await import("@pin/capacitor-ambient-ai") as unknown as {
    AmbientAi?: { models?: NativeModelsApi };
  };
  if (!mod.AmbientAi?.models) throw new Error("AmbientModels unavailable");
  return mod.AmbientAi.models;
}

async function selectedModelReadiness(
  api: NativeModelsApi,
  modelId: string,
): Promise<{ ok: true } | { ok: false; errorCode: AmbientTimelineGenerationErrorCode }> {
  const result = await api.list();
  const profile = result.profiles.find((item) => item.id === modelId);
  if (!profile) return { ok: false, errorCode: "model_not_found" };
  if (profile.kind !== "llm") return { ok: false, errorCode: "model_not_llm" };
  const status = result.statuses.find((item) => item.id === modelId);
  if (status?.state !== "present") return { ok: false, errorCode: "model_not_present" };
  if (status.lastVerifyResult === "ok") return { ok: true };
  try {
    const verify = await api.verifyModel({ id: modelId });
    return verify.ok ? { ok: true } : { ok: false, errorCode: "verify_required" };
  } catch {
    return { ok: false, errorCode: "verify_required" };
  }
}

function modelBatchPayload(input: AmbientTimelineBatchGenerationInput): Record<string, unknown> {
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

function normalizeBatchDecision(
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
    const title = shortText(row.title ?? row.t, 60);
    const summary = shortText(row.summary ?? row.s, 180);
    if (!title || !summary) return null;
    const rawImportance = row.importance ?? row.i;
    const importance: "low" | "medium" | "high" = isImportance(rawImportance) ? rawImportance : "medium";
    const occurredAt = shortPlainText(row.occurredAt, 64)
      ?? shortPlainText(primaryWindow?.startedAt, 64);
    if (!occurredAt) return null;
    return { action: "create", title, summary, importance, occurredAt, sourceWindowIds };
  }
  if (action === "update") {
    const eventId = shortPlainText(row.eventId ?? row.e, 128);
    const summary = shortText(row.summary ?? row.s, 180);
    const title = shortText(row.title ?? row.t, 60) ?? undefined;
    if (!eventId || !summary) return null;
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

function importanceFromConfidence(confidence: number): "low" | "medium" | "high" {
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

function modelWindowPayload(
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

function normalizeDraft(value: unknown): AmbientTimelineEventDraft | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const eventType = EVENT_TYPES.includes(row.eventType as AmbientTimelineEvent["eventType"])
    ? row.eventType as AmbientTimelineEvent["eventType"]
    : "other";
  const title = shortText(row.title, 80);
  const summary = shortText(row.summary, 220);
  if (!title || !summary) return null;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof err === "string" && err.trim()) return err.trim();
  return undefined;
}

function normalizeErrorCode(err: unknown): AmbientTimelineGenerationErrorCode {
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
    "generation_failed",
  ].includes(value);
}
