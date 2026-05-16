import type { PersonalSignalInput } from "@/lib/devices";
import type { AmbientCandidateWindow, AmbientTimelineEvent } from "./types";
import {
  AMBIENT_TIMELINE_KIND,
  AMBIENT_TIMELINE_SCHEMA_VERSION,
} from "./types";

export const AMBIENT_LOCATION_UPDATE_KIND = "ambient.location_update";
export const AMBIENT_VISIT_EVENT_KIND = "ambient.visit_event";

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


export type LocationUpdateReason = "first_fix" | "place_changed" | "distance_changed" | "time_elapsed";
export type VisitEventKind = "arrival" | "departure";

export function locationUpdateWindowToSignal(
  window: AmbientCandidateWindow,
  reason: LocationUpdateReason,
): PersonalSignalInput {
  return {
    id: `ambient-location-${window.id}`,
    kind: AMBIENT_LOCATION_UPDATE_KIND,
    title: "Location update",
    summary: window.compactContext,
    occurred_at: window.startedAt,
    available_at: window.startedAt,
    salience: window.salienceHint,
    confidence: window.confidenceHint,
    dedupe_key: `ambient:location_update:${window.localDate}:${window.id}`,
    payload: {
      schema_version: "ambient_location_update.v1",
      local_window_id: window.id,
      window_type: window.windowType,
      source_types: window.sourceTypes,
      privacy: window.privacyHint,
      confidence: window.confidenceHint,
      salience: window.salienceHint,
      local_date: window.localDate,
      started_at: window.startedAt,
      ...(window.endedAt ? { ended_at: window.endedAt } : {}),
      ...signalMetadata(window.metadata),
      raw_ref_count: window.rawRefs.length,
      reason,
    },
  };
}

export function visitWindowToSignal(
  window: AmbientCandidateWindow,
  visitKind: VisitEventKind,
): PersonalSignalInput {
  return {
    id: `ambient-visit-${window.id}`,
    kind: AMBIENT_VISIT_EVENT_KIND,
    title: "Visit event",
    summary: window.compactContext,
    occurred_at: window.startedAt,
    available_at: window.startedAt,
    salience: window.salienceHint,
    confidence: window.confidenceHint,
    dedupe_key: `ambient:visit_event:${window.localDate}:${window.id}`,
    payload: {
      schema_version: "ambient_visit_event.v1",
      local_window_id: window.id,
      window_type: window.windowType,
      source_types: window.sourceTypes,
      privacy: window.privacyHint,
      local_date: window.localDate,
      started_at: window.startedAt,
      ...(window.endedAt ? { ended_at: window.endedAt } : {}),
      ...signalMetadata(window.metadata),
      raw_ref_count: window.rawRefs.length,
      visit_kind: visitKind,
    },
  };
}

function signalMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}
