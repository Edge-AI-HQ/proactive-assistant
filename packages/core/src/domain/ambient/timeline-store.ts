// In-memory ambient timeline store (lifted from web services/ambient/.../store.ts).
// Platform-free: pure Map-backed CRUD over the ambient timeline domain types,
// no React, no Capacitor, no storage SDK. The Capacitor SQLite store, the
// pipeline runtime and the local-model bridge stay in each app; the web app
// re-exports MemoryTimelineStore from here so existing
// `@/services/ambient/...` importers are unaffected.
//
// `effectiveGenerationSource` / `timelineVisiblePayloadChanged` are exported
// because the SQLite store (which stays in the web app) shares them; keeping a
// single definition avoids drift between the two store implementations.
import type {
  AmbientCandidateWindow,
  AmbientRawEvent,
  AmbientRawRef,
  AmbientSourceType,
  AmbientTimelineEvent,
  AmbientTimelineStore,
  AmbientWindowType,
  TimelineEventUpsertResult,
  TimelineListOptions,
  TimelineStoreStatus,
} from "./types";
import { jsonCloneRecord } from "./utils";
import {
  DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
  type AmbientSummarySchedulerState,
} from "./summary-scheduler";

export class MemoryTimelineStore implements AmbientTimelineStore {
  readonly kind = "memory" as const;
  private rawEvents = new Map<string, AmbientRawEvent>();
  private windows = new Map<string, AmbientCandidateWindow>();
  private events = new Map<string, AmbientTimelineEvent>();
  private ready = false;
  private lastError: string | null = null;
  private summarySchedulerState: AmbientSummarySchedulerState | null = null;

  async init(): Promise<void> {
    this.ready = true;
    this.lastError = null;
  }

  status(): TimelineStoreStatus {
    return { mode: this.kind, ready: this.ready, lastError: this.lastError };
  }

  async upsertRawEvent(event: AmbientRawEvent): Promise<AmbientRawEvent> {
    await this.initIfNeeded();
    const existing = Array.from(this.rawEvents.values()).find(
      (row) => row.dedupeKey === event.dedupeKey,
    );
    const next = cloneRawEvent({
      ...(existing ?? event),
      ...event,
      id: existing?.id ?? event.id,
      createdAt: existing?.createdAt ?? event.createdAt,
    });
    this.rawEvents.set(next.id, next);
    return cloneRawEvent(next);
  }

  async listRawEvents(filter: {
    localDate?: string;
    sourceType?: AmbientSourceType;
    eventType?: string;
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<AmbientRawEvent[]> {
    await this.initIfNeeded();
    const sorted = Array.from(this.rawEvents.values())
      .filter((row) => !filter.localDate || row.localDate === filter.localDate)
      .filter((row) => !filter.sourceType || row.sourceType === filter.sourceType)
      .filter((row) => !filter.eventType || row.eventType === filter.eventType)
      .sort(compareByOccurredAtAsc);
    if (filter.order === "desc") sorted.reverse();
    return sorted
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map(cloneRawEvent);
  }

  async getRawEventsByRefs(refs: AmbientRawRef[]): Promise<AmbientRawEvent[]> {
    await this.initIfNeeded();
    const ids = new Set(refs.map((ref) => ref.id));
    return Array.from(this.rawEvents.values())
      .filter((row) => ids.has(row.id))
      .sort(compareByOccurredAtAsc)
      .map(cloneRawEvent);
  }

  async listRawEventsInRange(filter: {
    localDate: string;
    sourceType?: AmbientSourceType;
    eventType?: string;
    start: string;
    end: string;
    limit?: number;
  }): Promise<AmbientRawEvent[]> {
    await this.initIfNeeded();
    const startTs = Date.parse(filter.start);
    const endTs = Date.parse(filter.end);
    return Array.from(this.rawEvents.values())
      .filter((row) => row.localDate === filter.localDate)
      .filter((row) => !filter.sourceType || row.sourceType === filter.sourceType)
      .filter((row) => !filter.eventType || row.eventType === filter.eventType)
      .filter((row) => {
        const rowStart = Date.parse(row.occurredAt);
        const rowEnd = Date.parse(row.endedAt ?? row.occurredAt);
        return Number.isFinite(rowStart)
          && Number.isFinite(rowEnd)
          && rowStart <= endTs
          && rowEnd >= startTs;
      })
      .sort(compareByOccurredAtAsc)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map(cloneRawEvent);
  }


  async upsertCandidateWindow(
    window: AmbientCandidateWindow,
  ): Promise<AmbientCandidateWindow> {
    await this.initIfNeeded();
    const existing = this.windows.get(window.id);
    const next = cloneWindow({
      ...(existing ?? window),
      ...window,
      lastAttemptAt: window.lastAttemptAt ?? existing?.lastAttemptAt ?? null,
      attemptCount: window.attemptCount ?? existing?.attemptCount ?? 0,
      lastErrorCode: window.lastErrorCode ?? existing?.lastErrorCode ?? null,
      createdAt: existing?.createdAt ?? window.createdAt,
    });
    this.windows.set(next.id, next);
    return cloneWindow(next);
  }

  async listCandidateWindows(filter: {
    localDate?: string;
    windowType?: AmbientWindowType;
    status?: AmbientCandidateWindow["status"];
    summaryStatus?: NonNullable<AmbientCandidateWindow["summaryStatus"]>;
    limit?: number;
  }): Promise<AmbientCandidateWindow[]> {
    await this.initIfNeeded();
    return Array.from(this.windows.values())
      .filter((row) => !filter.localDate || row.localDate === filter.localDate)
      .filter((row) => !filter.windowType || row.windowType === filter.windowType)
      .filter((row) => !filter.status || row.status === filter.status)
      .filter((row) => !filter.summaryStatus || effectiveSummaryStatus(row) === filter.summaryStatus)
      .sort(compareByStartedAtAsc)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map(cloneWindow);
  }

  async upsertTimelineEvent(
    event: AmbientTimelineEvent,
  ): Promise<TimelineEventUpsertResult> {
    await this.initIfNeeded();
    const existing = this.events.get(event.id);
    if (existing?.generationStatus === "hidden") {
      return { event: cloneTimelineEvent(existing), shouldSync: false };
    }
    const visibleChanged = existing
      ? timelineVisiblePayloadChanged(existing, event)
      : false;
    const next = cloneTimelineEvent({
      ...(existing ?? event),
      ...event,
      syncStatus: existing?.syncStatus === "synced" && visibleChanged ? "pending" : event.syncStatus,
      createdAt: existing?.createdAt ?? event.createdAt,
      dismissedAt: existing?.dismissedAt,
    });
    this.events.set(next.id, next);
    return {
      event: cloneTimelineEvent(next),
      shouldSync:
        next.generationStatus === "visible" && (existing?.syncStatus !== "synced" || visibleChanged),
    };
  }

  async listTimelineEvents(
    localDate: string,
    options: TimelineListOptions = {},
  ): Promise<AmbientTimelineEvent[]> {
    await this.initIfNeeded();
    return this.listTimelineEventsFromMemory(localDate, options);
  }

  async listTimelineEventsByGenerationSource(
    localDate: string,
    generationSource: NonNullable<AmbientTimelineEvent["generationSource"]>,
    options: TimelineListOptions = {},
  ): Promise<AmbientTimelineEvent[]> {
    await this.initIfNeeded();
    return this.listTimelineEventsFromMemory(localDate, options)
      .then((rows) => rows.filter((row) => effectiveGenerationSource(row) === generationSource));
  }

  private async listTimelineEventsFromMemory(
    localDate: string,
    options: TimelineListOptions = {},
  ): Promise<AmbientTimelineEvent[]> {
    return Array.from(this.events.values())
      .filter((row) => row.localDate === localDate)
      .filter((row) => (
        options.visibleOnly ? row.generationStatus === "visible" : true
      ))
      .sort(compareTimelineAsc)
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .map(cloneTimelineEvent);
  }

  async dismissTimelineEvent(id: string, at = new Date().toISOString()): Promise<void> {
    await this.initIfNeeded();
    const existing = this.events.get(id);
    if (!existing) return;
    this.events.set(id, {
      ...existing,
      generationStatus: "hidden",
      dismissedAt: at,
      updatedAt: at,
    });
  }

  async markTimelineEventsSynced(ids: string[], at = new Date().toISOString()): Promise<void> {
    await this.initIfNeeded();
    const idSet = new Set(ids);
    for (const [id, event] of this.events) {
      if (!idSet.has(id)) continue;
      this.events.set(id, { ...event, syncStatus: "synced", updatedAt: at });
    }
  }

  async getSummarySchedulerState(): Promise<AmbientSummarySchedulerState> {
    await this.initIfNeeded();
    return cloneSummarySchedulerState(this.summarySchedulerState ?? DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE);
  }

  async setSummarySchedulerState(state: AmbientSummarySchedulerState): Promise<void> {
    await this.initIfNeeded();
    this.summarySchedulerState = cloneSummarySchedulerState(state);
  }

  private async initIfNeeded(): Promise<void> {
    if (!this.ready) await this.init();
  }
}

function cloneRawEvent(event: AmbientRawEvent): AmbientRawEvent {
  return { ...event, payload: jsonCloneRecord(event.payload) };
}

function cloneWindow(window: AmbientCandidateWindow): AmbientCandidateWindow {
  return {
    ...window,
    summaryStatus: effectiveSummaryStatus(window),
    summaryRunId: window.summaryRunId ?? null,
    summaryProcessingExpiresAt: window.summaryProcessingExpiresAt ?? null,
    summaryErrorCode: window.summaryErrorCode ?? null,
    summaryErrorMessage: window.summaryErrorMessage ?? null,
    sourceTypes: [...window.sourceTypes],
    deviceLabels: [...window.deviceLabels],
    rawRefs: window.rawRefs.map((ref) => ({ ...ref })),
    observationIds: [...window.observationIds],
  };
}

function cloneTimelineEvent(event: AmbientTimelineEvent): AmbientTimelineEvent {
  return {
    ...event,
    generationSource: effectiveGenerationSource(event),
    sourceWindowIds: [...(event.sourceWindowIds ?? [])],
    deviceLabels: [...event.deviceLabels],
    sourceTypes: [...event.sourceTypes],
    tags: [...event.tags],
    rawRefs: event.rawRefs.map((ref) => ({ ...ref })),
    observationIds: [...event.observationIds],
    ...(event.actionCandidates && event.actionCandidates.length > 0
      ? {
          actionCandidates: event.actionCandidates.map((action) => ({
            label: action.label,
            goal: action.goal,
            ...(action.goalBasket ? { goalBasket: action.goalBasket } : {}),
          })),
        }
      : {}),
  };
}

export function effectiveGenerationSource(event: AmbientTimelineEvent): NonNullable<AmbientTimelineEvent["generationSource"]> {
  return event.generationSource ?? (event.generationMethod === "local_llm" || event.generationMethod === "cloud_llm" ? "llm_summary" : "rule_based");
}

function effectiveSummaryStatus(window: AmbientCandidateWindow): NonNullable<AmbientCandidateWindow["summaryStatus"]> {
  return window.summaryStatus ?? (window.status === "generated" ? "summarized" : "pending");
}

function compareByOccurredAtAsc(a: AmbientRawEvent, b: AmbientRawEvent): number {
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
}

function compareByStartedAtAsc(
  a: AmbientCandidateWindow,
  b: AmbientCandidateWindow,
): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

function compareTimelineAsc(
  a: AmbientTimelineEvent,
  b: AmbientTimelineEvent,
): number {
  const occurred = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (occurred !== 0) return occurred;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

export function timelineVisiblePayloadChanged(
  existing: AmbientTimelineEvent,
  next: AmbientTimelineEvent,
): boolean {
  return existing.title !== next.title
    || existing.summary !== next.summary
    || existing.eventType !== next.eventType
    || existing.privacy !== next.privacy
    || existing.confidence !== next.confidence
    || existing.confidenceLabel !== next.confidenceLabel
    || existing.salience !== next.salience
    || JSON.stringify(existing.tags) !== JSON.stringify(next.tags)
    || JSON.stringify(existing.sourceTypes) !== JSON.stringify(next.sourceTypes);
}

function cloneSummarySchedulerState(state: AmbientSummarySchedulerState): AmbientSummarySchedulerState {
  return { ...state };
}
