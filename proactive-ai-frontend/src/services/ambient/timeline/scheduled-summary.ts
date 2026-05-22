import { buildAmbientSummaryContext, type AmbientSummaryContext } from "./summary-context";
import {
  recordAmbientSummaryFailure,
  recordAmbientSummaryModelError,
  recordAmbientSummaryNoContent,
  recordAmbientSummarySuccess,
  shouldRunAmbientSummary,
} from "./summary-scheduler";
import type { AmbientTimelineEvent, AmbientTimelineStore } from "./types";

export interface AmbientSummaryEventDraft {
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: AmbientTimelineEvent["confidenceLabel"];
}

export interface AmbientSummaryModelBridge {
  generateAmbientSummaryEvent(
    context: AmbientSummaryContext,
  ): Promise<
    | {
      ok: true;
      draft: AmbientSummaryEventDraft;
      modelId?: string;
      generationMethod?: "local_llm" | "cloud_llm";
      primarySourceLabel?: string;
    }
    | { ok: false; errorCode: string; errorMessage?: string }
  >;
}

export async function maybeRunScheduledAmbientSummary(input: {
  store: AmbientTimelineStore;
  bridge: AmbientSummaryModelBridge;
  now: Date;
  localDate: string;
  timezone: string;
  localUserId: string;
  shouldPersistResult?: (result: { generationMethod?: "local_llm" | "cloud_llm" }) => boolean;
}): Promise<{ ran: false; status: "not_due" } | { ran: true; status: "success" | "no_content" | "failed" }> {
  const currentState = await input.store.getSummarySchedulerState();
  const nowMs = input.now.getTime();
  if (!shouldRunAmbientSummary(currentState, input.now)) return { ran: false, status: "not_due" };

  const nowIso = input.now.toISOString();
  const startIso = new Date(nowMs - 15 * 60_000).toISOString();
  const rawEvents = await input.store.listRawEventsInRange({
    localDate: input.localDate,
    start: startIso,
    end: nowIso,
    limit: 80,
  });
  if (rawEvents.length === 0) {
    await input.store.setSummarySchedulerState(recordAmbientSummaryNoContent(currentState, input.now));
    return { ran: true, status: "no_content" };
  }

  const recentSummaries = await input.store.listTimelineEventsByGenerationSource(
    input.localDate,
    "llm_summary",
    { visibleOnly: true, limit: 3 },
  );
  const context = buildAmbientSummaryContext({
    nowIso,
    localDate: input.localDate,
    rawEvents,
    recentSummaries,
  });
  const result = await input.bridge.generateAmbientSummaryEvent(context);
  if (!result.ok) {
    const modelErrors = new Set(["no_selected_model", "model_not_found", "model_not_llm", "model_not_present", "verify_required"]);
    await input.store.setSummarySchedulerState(
      modelErrors.has(result.errorCode)
        ? recordAmbientSummaryModelError(currentState, input.now, result.errorCode, result.errorMessage)
        : recordAmbientSummaryFailure(currentState, input.now, result.errorCode, result.errorMessage),
    );
    return { ran: true, status: "failed" };
  }

  if (input.shouldPersistResult && !input.shouldPersistResult(result)) {
    await input.store.setSummarySchedulerState(
      recordAmbientSummaryFailure(
        currentState,
        input.now,
        "cloud_result_discarded_after_lock",
        "Cloud summary result was discarded because uploads were locked before persistence.",
      ),
    );
    return { ran: true, status: "failed" };
  }

  const sourceTypes = Array.from(new Set(rawEvents.map((event) => event.sourceType)));
  const id = `ambient-summary-${input.localDate}-${nowMs}`;
  const event: AmbientTimelineEvent = {
    id,
    localUserId: input.localUserId,
    localDate: input.localDate,
    timezone: input.timezone,
    occurredAt: nowIso,
    eventType: "other",
    title: result.draft.title,
    summary: result.draft.summary,
    primarySourceLabel: result.primarySourceLabel ?? "On-device summary",
    deviceLabels: Array.from(new Set(rawEvents.flatMap((event) => event.deviceId ? [event.deviceId] : []))).slice(0, 5),
    sourceTypes,
    tags: result.draft.tags,
    privacy: rawEvents.some((event) => event.sensitivity === "sensitive") ? "sensitive" : "private",
    confidence: result.draft.confidence,
    confidenceLabel: result.draft.confidenceLabel,
    salience: 0.7,
    rawRefs: rawEvents.map((event) => ({ sourceType: event.sourceType, id: event.id })),
    observationIds: [],
    generationMethod: result.generationMethod ?? "local_llm",
    generationSource: "llm_summary",
    sourceWindowIds: [],
    ...(result.modelId ? { llmModelId: result.modelId } : {}),
    llmGeneratedAt: nowIso,
    llmUpdatedAt: nowIso,
    idempotencyKey: id,
    generationStatus: "visible",
    memoryCandidate: true,
    cardTriggerCandidate: false,
    schemaVersion: "ambient_timeline_event.v1",
    syncStatus: "pending",
    dedupeKey: id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await input.store.upsertTimelineEvent(event);
  await input.store.setSummarySchedulerState(recordAmbientSummarySuccess(currentState, input.now));
  return { ran: true, status: "success" };
}
