// Pure types + LLM-output normalization now live in @pin-ai/core
// (domain/ambient/pipeline-models); re-exported here so existing
// "@/services/ambient/..." importers keep working unchanged. The native model
// bridge below stays in this app because it binds to @pin/capacitor-ambient-ai
// and the localStorage-backed model selection. Delete this shim's re-exports
// when the Capacitor shell retires.
import {
  importanceFromConfidence,
  modelBatchPayload,
  modelWindowPayload,
  normalizeBatchDecision,
  normalizeDraft,
  normalizeErrorCode,
  normalizeErrorMessage,
  type AmbientTimelineBatchGenerationInput,
  type AmbientTimelineBatchGenerationResult,
  type AmbientTimelineGenerationErrorCode,
  type AmbientTimelineGenerationResult,
  type AmbientTimelineEventDraft,
  type AmbientTimelineModelBridge,
  type AmbientWindowSummary,
  type LlmTimelineDecision,
  type AmbientSummaryContext,
  type AmbientCandidateWindow,
} from "@pin-ai/core";
import { getSelectedAmbientSummaryModelId } from "../models-selection";

export type {
  AmbientTimelineEventDraft,
  AmbientWindowSummary,
  AmbientTimelineGenerationErrorCode,
  AmbientTimelineGenerationResult,
  AmbientTimelineBatchGenerationInput,
  LlmTimelineDecision,
  AmbientTimelineBatchGenerationResult,
  AmbientTimelineModelBridge,
} from "@pin-ai/core";

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
  generateAmbientSummaryEvent?(options: {
    modelId: string;
    context: Record<string, unknown>;
  }): Promise<unknown>;
}

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

  async generateAmbientSummaryEvent(
    context: AmbientSummaryContext,
  ): Promise<{ ok: true; draft: AmbientTimelineEventDraft; modelId?: string } | { ok: false; errorCode: AmbientTimelineGenerationErrorCode; errorMessage?: string }> {
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
    if (!api.generateAmbientSummaryEvent) return { ok: false, errorCode: "generation_failed", errorMessage: "Native ambient summary generation unavailable" };
    try {
      const value = await api.generateAmbientSummaryEvent({ modelId, context: context as unknown as Record<string, unknown> });
      const draft = normalizeDraft(value);
      return draft
        ? { ok: true, draft, modelId }
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
      const draft = normalizeDraft(value, window);
      return draft
        ? { ok: true, draft }
        : { ok: false, errorCode: "invalid_shape" };
    } catch (err) {
      return { ok: false, errorCode: normalizeErrorCode(err), errorMessage: normalizeErrorMessage(err) };
    }
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
