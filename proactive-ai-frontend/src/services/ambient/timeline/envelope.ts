import type { PersonalSignalInput } from "@/lib/devices";
import type { AmbientCandidateWindow, AmbientSourceType, AmbientTimelineEvent } from "./types";
import {
  AMBIENT_CANDIDATE_WINDOW_KIND,
  AMBIENT_CANDIDATE_WINDOW_SCHEMA_VERSION,
  AMBIENT_TIMELINE_KIND,
  AMBIENT_TIMELINE_SCHEMA_VERSION,
} from "./types";
import { transcriptTextOnly } from "./utils";


export interface AmbientWindowSourcePayload {
  source_type: AmbientSourceType;
  event_type: string;
  occurred_at: string;
  ended_at?: string;
  confidence?: number;
  relation: "window_raw_ref" | "nearby_context";
  payload: Record<string, unknown>;
}

export interface CandidateWindowSignalContext {
  sourcePayloads: AmbientWindowSourcePayload[];
  contextHash: string;
}

export function candidateWindowToSignal(
  window: AmbientCandidateWindow,
  context: CandidateWindowSignalContext,
): PersonalSignalInput {
  const availableAt = window.endedAt ?? window.startedAt;
  const dedupeKey = window.windowType === "transcript_session"
    ? `ambient:candidate_window:${window.localDate}:transcript_session:${window.id}`
    : `ambient:candidate_window:${window.localDate}:${window.id}`;
  const compactContext = window.windowType === "transcript_session"
    ? transcriptTextOnly(window.compactContext)
    : window.compactContext;
  return {
    id: `ambient_candidate_window_${safeIdPart(window.id)}`,
    kind: AMBIENT_CANDIDATE_WINDOW_KIND,
    title: `Ambient ${window.windowType} window`,
    summary: compactContext,
    occurred_at: window.startedAt,
    available_at: availableAt,
    salience: window.salienceHint,
    confidence: window.confidenceHint,
    dedupe_key: dedupeKey,
    payload: {
      schema_version: AMBIENT_CANDIDATE_WINDOW_SCHEMA_VERSION,
      local_window_id: window.id,
      window_type: window.windowType,
      source_types: window.sourceTypes,
      privacy: window.privacyHint,
      local_date: window.localDate,
      started_at: window.startedAt,
      ...(window.endedAt ? { ended_at: window.endedAt } : {}),
      timezone: window.timezone,
      compact_context: compactContext,
      content_hash: context.contextHash,
      confidence_hint: window.confidenceHint,
      salience_hint: window.salienceHint,
      generation_policy: window.generationPolicy,
      window_status: window.status,
      raw_ref_count: window.rawRefs.length,
      source_payloads: context.sourcePayloads,
    },
  };
}

export function timelineEventToSignal(
  event: AmbientTimelineEvent,
): PersonalSignalInput {
  return {
    id: event.id,
    kind: AMBIENT_TIMELINE_KIND,
    title: event.title,
    summary: event.summary,
    occurred_at: event.occurredAt,
    available_at: event.occurredAt,
    salience: event.salience,
    confidence: event.confidence,
    dedupe_key: event.dedupeKey,
    payload: {
      event_type: event.eventType,
      tags: event.tags,
      privacy: event.privacy,
      confidence_label: event.confidenceLabel,
      source_types: event.sourceTypes,
      local_event_id: event.id,
      schema_version: AMBIENT_TIMELINE_SCHEMA_VERSION,
      ...(event.triggeredCardId
        ? { triggered_card_id: event.triggeredCardId }
        : {}),
      ...(event.triggeredCardTitle
        ? { triggered_card_title: event.triggeredCardTitle }
        : {}),
    },
  };
}

export function localEventIdsFromSignals(
  items: PersonalSignalInput[],
): string[] {
  return items.flatMap((item) => {
    if (item.kind !== AMBIENT_TIMELINE_KIND) return [];
    const id = item.payload?.local_event_id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}


function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
