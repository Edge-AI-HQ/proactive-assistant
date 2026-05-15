import type { PersonalSignalInput } from "@/lib/devices";
import { SIGNAL_KINDS } from "../kinds";
import type {
  AmbientPrivacy,
  AmbientRawEvent,
  AmbientSourceType,
} from "./types";
import {
  cleanText,
  currentTimezone,
  jsonCloneRecord,
  localDateFromIso,
  parseOptionalNumber,
  stableHash,
  stableId,
} from "./utils";

const RAW_SCHEMA_VERSION = "ambient_raw_event.v1";

export function rawEventFromSignal(item: PersonalSignalInput): AmbientRawEvent {
  const now = new Date().toISOString();
  const occurredAt = normalizeIso(item.occurred_at) ?? now;
  const payload = item.payload ? jsonCloneRecord(item.payload) : {};
  const sourceType = sourceTypeFromSignal(item.kind);
  const eventType = rawEventType(item.kind, payload);
  const dedupeKey = item.dedupe_key
    ?? `${sourceType}:${eventType}:${occurredAt}:${stableHash(JSON.stringify(payload))}`;
  const contentHash = stableHash(JSON.stringify({
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    payload,
    occurredAt,
  }));

  return {
    id: stableId("raw", [dedupeKey]),
    localUserId: "local",
    deviceId: cleanText(item.source),
    sourceType,
    eventType,
    sourceVersion: RAW_SCHEMA_VERSION,
    occurredAt,
    endedAt: endedAtForRaw(item, payload),
    collectedAt: now,
    timezone: currentTimezone(),
    localDate: localDateFromIso(occurredAt),
    payload: {
      ...payload,
      signal_kind: item.kind,
      signal_title: item.title,
      signal_summary: item.summary,
    },
    compactText: compactText(item, sourceType, eventType, payload),
    confidence: parseOptionalNumber(item.confidence),
    sensitivity: privacyForSource(sourceType),
    permissionState: cleanText(payload.permission_state),
    ttlExpiresAt: item.expires_at ?? null,
    contentHash,
    dedupeKey,
    processingStatus: "new",
    createdAt: now,
    updatedAt: now,
  };
}

export function sourceTypeFromSignal(kind: string): AmbientSourceType {
  if (kind === "session_summary") return "transcript";
  if (kind === "health.observation") return "health";
  if (kind === SIGNAL_KINDS.visit) return "visit";
  if (kind === SIGNAL_KINDS.location) return "location";
  if (kind === SIGNAL_KINDS.activity) return "motion";
  if (kind === SIGNAL_KINDS.soundClassification) return "sound";
  return "sound";
}

export function privacyForSource(sourceType: AmbientSourceType): AmbientPrivacy {
  switch (sourceType) {
    case "health":
      return "sensitive";
    case "location":
    case "visit":
    case "transcript":
    case "calendar":
      return "private";
    case "motion":
    case "sound":
      return "normal";
  }
}

function rawEventType(
  kind: string,
  payload: Record<string, unknown>,
): string {
  if (kind === "session_summary") return "transcript.ready";
  if (kind === "health.observation") return "health.summary";
  if (kind === SIGNAL_KINDS.location) return "location.fix";
  if (kind === SIGNAL_KINDS.activity) return "motion.activity";
  if (kind === SIGNAL_KINDS.soundClassification) return "sound.frame";
  if (kind === SIGNAL_KINDS.visit) {
    const visitKind = cleanText(payload.kind);
    return visitKind === "departure" ? "visit.departure" : "visit.arrival";
  }
  return kind;
}

function compactText(
  item: PersonalSignalInput,
  sourceType: AmbientSourceType,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  if (sourceType === "visit") {
    const place = placeLabel(payload);
    if (eventType === "visit.departure") {
      return `Departed ${place ? `near ${place}` : "a place"}. ${item.summary}`;
    }
    return `Arrived ${place ? `near ${place}` : "at a place"}. ${item.summary}`;
  }
  if (sourceType === "location") {
    const place = placeLabel(payload);
    return place ? `Location near ${place}.` : item.summary;
  }
  if (sourceType === "motion") {
    const type = cleanText(payload.type);
    const confidence = cleanText(payload.confidence);
    return `Motion ${type ?? "activity"}${confidence ? ` (${confidence})` : ""}.`;
  }
  if (sourceType === "health") return `Health summary: ${item.summary}`;
  if (sourceType === "transcript") return `Transcript segment: ${item.summary}`;
  return item.summary;
}

function endedAtForRaw(
  item: PersonalSignalInput,
  payload: Record<string, unknown>,
): string | undefined {
  const direct = normalizeIso(cleanText(payload.end_at) ?? cleanText(payload.ended_at));
  if (direct) return direct;
  const departure = normalizeIso(cleanText(payload.departure_at));
  if (departure) return departure;
  const durationMs = parseOptionalNumber(payload.durationMs);
  if (!durationMs || !item.occurred_at) return undefined;
  const start = Date.parse(item.occurred_at);
  if (!Number.isFinite(start)) return undefined;
  return new Date(start + durationMs).toISOString();
}

export function placeLabel(payload: Record<string, unknown>): string | null {
  const direct = cleanText(payload.place_label);
  if (direct) return direct;
  const place = payload.place;
  if (!place || typeof place !== "object") return null;
  const row = place as Record<string, unknown>;
  return cleanText(row.label)
    ?? cleanText(row.place_name)
    ?? cleanText(row.address);
}

function normalizeIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}
