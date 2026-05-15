export const AMBIENT_TIMELINE_KIND = "ambient.timeline_event";
export const AMBIENT_TIMELINE_SCHEMA_VERSION = "ambient_timeline_event.v1";

export type AmbientSourceType =
  | "sound"
  | "location"
  | "visit"
  | "transcript"
  | "health"
  | "motion"
  | "calendar";

export interface AmbientRawRef {
  sourceType: AmbientSourceType;
  id: string;
}

export type AmbientPrivacy = "normal" | "private" | "sensitive";
export type AmbientConfidenceLabel = "certain" | "uncertain";

export type AmbientWindowType =
  | "morning_health"
  | "visit_stay"
  | "transition"
  | "transcript_session"
  | "workout"
  | "focus_block";

export type AmbientEventType =
  | "morning"
  | "visit"
  | "transition"
  | "conversation"
  | "meeting"
  | "focus"
  | "workout"
  | "health"
  | "social"
  | "other";

export interface AmbientRawEvent {
  id: string;
  localUserId: string;
  deviceId: string | null;
  sourceType: AmbientSourceType;
  eventType: string;
  sourceVersion: string;
  occurredAt: string;
  endedAt?: string;
  collectedAt: string;
  timezone: string;
  localDate: string;
  payload: Record<string, unknown>;
  compactText: string;
  confidence: number | null;
  sensitivity: AmbientPrivacy;
  permissionState: string | null;
  ttlExpiresAt: string | null;
  contentHash: string;
  dedupeKey: string;
  processingStatus: "new" | "observed" | "windowed" | "ignored";
  createdAt: string;
  updatedAt: string;
}

export interface AmbientCandidateWindow {
  id: string;
  localUserId: string;
  localDate: string;
  windowType: AmbientWindowType;
  startedAt: string;
  endedAt?: string;
  timezone: string;
  sourceTypes: AmbientSourceType[];
  deviceLabels: string[];
  rawRefs: AmbientRawRef[];
  observationIds: string[];
  compactContext: string;
  privacyHint: AmbientPrivacy;
  confidenceHint: number;
  salienceHint: number;
  generationPolicy: "rule_only" | "llm_allowed" | "do_not_generate";
  llmInputHash: string | null;
  status: "pending" | "generated" | "ignored";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmbientTimelineEvent {
  id: string;
  localUserId: string;
  localDate: string;
  timezone: string;
  occurredAt: string;
  endedAt?: string;
  eventType: AmbientEventType;
  title: string;
  summary: string;
  primarySourceLabel: string;
  deviceLabels: string[];
  sourceTypes: AmbientSourceType[];
  tags: string[];
  privacy: AmbientPrivacy;
  confidence: number;
  confidenceLabel: AmbientConfidenceLabel;
  salience: number;
  rawRefs: AmbientRawRef[];
  observationIds: string[];
  windowId?: string;
  generationMethod: "rule" | "local_llm";
  generationStatus: "draft" | "visible" | "hidden";
  dismissedAt?: string;
  memoryCandidate: boolean;
  cardTriggerCandidate: boolean;
  triggeredCardId?: string;
  triggeredCardTitle?: string;
  schemaVersion: typeof AMBIENT_TIMELINE_SCHEMA_VERSION;
  syncStatus: "local_only" | "pending" | "blocked" | "synced" | "failed";
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineStoreStatus {
  mode: "memory" | "sqlite";
  ready: boolean;
  lastError: string | null;
}

export interface TimelineListOptions {
  visibleOnly?: boolean;
  limit?: number;
}

export interface TimelineEventUpsertResult {
  event: AmbientTimelineEvent;
  shouldSync: boolean;
}

export interface AmbientTimelineStore {
  readonly kind: "memory" | "sqlite";
  init(): Promise<void>;
  status(): TimelineStoreStatus;
  upsertRawEvent(event: AmbientRawEvent): Promise<AmbientRawEvent>;
  listRawEvents(filter: {
    localDate?: string;
    sourceType?: AmbientSourceType;
    eventType?: string;
    limit?: number;
  }): Promise<AmbientRawEvent[]>;
  upsertCandidateWindow(
    window: AmbientCandidateWindow,
  ): Promise<AmbientCandidateWindow>;
  listCandidateWindows(filter: {
    localDate?: string;
    windowType?: AmbientWindowType;
    status?: AmbientCandidateWindow["status"];
    limit?: number;
  }): Promise<AmbientCandidateWindow[]>;
  upsertTimelineEvent(
    event: AmbientTimelineEvent,
  ): Promise<TimelineEventUpsertResult>;
  listTimelineEvents(
    localDate: string,
    options?: TimelineListOptions,
  ): Promise<AmbientTimelineEvent[]>;
  dismissTimelineEvent(id: string, at?: string): Promise<void>;
  markTimelineEventsSynced(ids: string[], at?: string): Promise<void>;
}
