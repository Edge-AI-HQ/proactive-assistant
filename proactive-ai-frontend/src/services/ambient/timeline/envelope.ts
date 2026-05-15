import type { PersonalSignalInput } from "@/lib/devices";
import type { AmbientTimelineEvent } from "./types";
import {
  AMBIENT_TIMELINE_KIND,
  AMBIENT_TIMELINE_SCHEMA_VERSION,
} from "./types";

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
