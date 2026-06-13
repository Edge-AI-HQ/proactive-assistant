import type { AmbientRawEvent, AmbientSourceType, AmbientTimelineEvent } from "./types";
import { speakerAwareTranscriptTextFromPayload } from "./speaker-transcript";

export interface AmbientSummaryContextRawEvent {
  id: string;
  sourceType: AmbientSourceType;
  eventType: string;
  occurredAt: string;
  endedAt?: string;
  text: string;
  selfText?: string;
  sensitivity: AmbientRawEvent["sensitivity"];
  confidence: number | null;
}

export interface AmbientSummaryContextRecentSummary {
  id: string;
  occurredAt: string;
  title: string;
  summary: string;
  sourceTypes: AmbientSourceType[];
}

export interface AmbientSummaryContext {
  schemaVersion: "ambient_summary.v1";
  localDate: string;
  generatedAt: string;
  rawEvents: AmbientSummaryContextRawEvent[];
  recentSummaries: AmbientSummaryContextRecentSummary[];
}

export function buildAmbientSummaryContext(input: {
  nowIso: string;
  localDate: string;
  rawEvents: AmbientRawEvent[];
  recentSummaries?: AmbientTimelineEvent[];
}): AmbientSummaryContext {
  return {
    schemaVersion: "ambient_summary.v1",
    localDate: input.localDate,
    generatedAt: input.nowIso,
    rawEvents: input.rawEvents
      .slice()
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .map((event) => ({
        id: event.id,
        sourceType: event.sourceType,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        ...(event.endedAt ? { endedAt: event.endedAt } : {}),
        text: truncate(summaryText(event), 260),
        ...(summarySelfText(event) ? { selfText: truncate(summarySelfText(event) ?? "", 260) } : {}),
        sensitivity: event.sensitivity,
        confidence: event.confidence,
      })),
    recentSummaries: (input.recentSummaries ?? [])
      .slice()
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, 3)
      .map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt,
        title: truncate(event.title, 80),
        summary: truncate(event.summary, 220),
        sourceTypes: event.sourceTypes.slice(0, 6),
      })),
  };
}

function summaryText(event: AmbientRawEvent): string {
  if (event.sourceType !== "transcript") return event.compactText;
  return speakerAwareTranscriptTextFromPayload(event.payload, event.compactText);
}

function summarySelfText(event: AmbientRawEvent): string | null {
  if (event.sourceType !== "transcript") return null;
  const value = event.payload.self_text;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
}
