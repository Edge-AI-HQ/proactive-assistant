import { readErrorMessage } from "../transport/errors";
import { proxyFetch } from "../transport/http";

// ── L1 event timeline (Ambient / Mirror) ──────────────────────────────────
//
// The bi-temporal event stream (pai_events). `GET /api/events` returns the
// active, curated timeline (newest-first), optionally filtered by eventType /
// time window. Read-only on the UI side — events are append-only and curated
// by evolve; the agent-facing semantic search + append live server-side.

export interface EventItem {
  id: string;
  source: string;
  eventType: string;
  /** ISO-8601 occurrence time (can be in the future for meetings / predicted.*). */
  occurredAt: string;
  /** ISO-8601 end time for interval events (null for point-in-time). */
  endAt: string | null;
  /** ISO-8601 time the system learned of the event — bi-temporal 2nd axis. */
  recordedAt: string | null;
  title: string | null;
  body: string | null;
  /** Structured payload for the event_type (shape varies by type). */
  structured: Record<string, unknown>;
  /** ISO-8601 curation time; null = still in evolve's uncurated queue (pending). */
  curatedAt: string | null;
  /** How many agent runs have retrieved this event (usage heat). */
  referenceCount: number;
  /** Visual weight (type prior × usage heat) — timeline maps it to point size/brightness. */
  importance: number;
}

export interface EventsFilter {
  eventType?: string;
  /** ISO-8601 lower bound (inclusive) on occurredAt. */
  since?: string;
  /** ISO-8601 upper bound (inclusive) on occurredAt. */
  until?: string;
  limit?: number;
}

export interface EventsResponse {
  items: EventItem[];
}

function normalizeEvent(raw: Partial<EventItem>): EventItem {
  return {
    id: raw.id ?? "",
    source: raw.source ?? "",
    eventType: raw.eventType ?? "",
    occurredAt: raw.occurredAt ?? "",
    endAt: raw.endAt ?? null,
    recordedAt: raw.recordedAt ?? null,
    title: raw.title ?? null,
    body: raw.body ?? null,
    structured: raw.structured ?? {},
    curatedAt: raw.curatedAt ?? null,
    referenceCount: raw.referenceCount ?? 0,
    importance: raw.importance ?? 0,
  };
}

export async function fetchEvents(
  filter?: EventsFilter,
  signal?: AbortSignal,
): Promise<EventsResponse> {
  const qs = new URLSearchParams();
  if (filter?.eventType) qs.set("eventType", filter.eventType);
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (filter?.limit) qs.set("limit", String(filter.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  // Trailing slash matches the backend route (`/api/events/`, @router.get("/")
  // under prefix="/api/events") — avoids a 307 redirect through the proxy.
  const res = await proxyFetch(`/events/${suffix}`, { signal });
  if (!res.ok) throw new Error(`/events failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as { items?: Partial<EventItem>[] };
  return {
    items: Array.isArray(data.items) ? data.items.map(normalizeEvent) : [],
  };
}
