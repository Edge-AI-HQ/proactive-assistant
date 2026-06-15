/**
 * Device ambient signal wire protocol — the single front-end mirror of the
 * PersonalSignal envelope that pinai-agents `/api/devices/ingest` accepts.
 *
 * SSOT for web (proactive-ai-frontend) and RN (apps/mobile). Both ends used
 * to hand-copy these shapes (web `lib/devices.ts`, RN `src/ambient/types.ts`)
 * and drift silently — RN had already shrunk SIGNAL_KINDS to a 5-key subset.
 * The container backend routes by `kind` and does not validate payload shape,
 * so adding a kind here is a frontend-only change.
 */

/**
 * One PersonalSignal in the wire format the server expects.
 * `id` and `occurred_at` are filled in by the ingest path if the caller does
 * not supply them — most call sites just push a kind + summary and move on.
 */
export interface PersonalSignalInput {
  id?: string;
  source?: string; // defaults to "device:<creds.deviceId>"
  kind: string;
  sync_mode?: "incremental" | "full";
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  occurred_at?: string; // ISO 8601, defaults to now()
  available_at?: string;
  expires_at?: string;
  salience?: number;
  confidence?: number;
  dedupe_key?: string;
}

/**
 * Server-side per-item status. Six states; the outbox must handle each:
 *   inserted | duplicate     → success, drop from queue
 *   filtered                 → accepted but intentionally not persisted
 *                              (deferred-sink kind) → drop, don't retry
 *   rejected | parse_failed  → permanent failure, drop + log
 *   retryable_failed         → transient server-side failure, keep + retry
 * Contract owner: pinai-agents `/api/devices/ingest`.
 */
export type IngestItemStatus =
  | "inserted"
  | "duplicate"
  | "filtered"
  | "rejected"
  | "parse_failed"
  | "retryable_failed";

export interface IngestItemResult {
  id: string;
  dedupeKey: string | null;
  status: IngestItemStatus;
  reason?: string;
}

export interface IngestResult {
  ok: boolean;
  accepted: number;
  inserted: number;
  ignored: number;
  results?: IngestItemResult[];
}

/**
 * PersonalSignal `kind` strings for ambient device sources.
 *
 * Naming follows the iOS integration guide: `<source_class>.<event_name>`,
 * snake_case. The container backend routes by `kind` and does not validate
 * payload shape, so adding a new kind here is a frontend-only change.
 */
export const SIGNAL_KINDS = {
  soundClassification: "device.sound_classification",
  soundSceneRun: "device.sound_scene_run",
  visit: "device.visit",
  activity: "device.activity",
  motionSegment: "device.motion_segment",
  location: "device.location",
  timelineEvent: "ambient.timeline_event",
  candidateWindow: "ambient.candidate_window",
  calendarEvent: "device.calendar_event",
  focusState: "device.focus_state",
  audioRoute: "device.audio_route",
  deviceState: "device.device_state",
} as const;

export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];
