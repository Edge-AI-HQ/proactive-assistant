/**
 * Ambient runtime — end-to-end glue from Capacitor plugin events to
 * `/api/proactive/devices/ingest`.
 *
 * The runtime is a long-lived end-side service that the React tree only
 * observes. Sources produce PersonalSignalInput objects, SignalBuffer batches
 * short bursts, the outbox owns retry state, and AmbientSyncScheduler drains
 * the outbox through the existing device ingest bridge.
 */
import { currentDeviceOwnerUserId, type PersonalSignalInput } from "@/lib/devices";
import { PIN_API_BASE, isNative } from "@/lib/platform";
import { SignalBuffer } from "./buffer";
import {
  ALL_SOURCE_KEYS,
  DEFAULT_AUTO_START_SOURCES,
  type SourceKey,
} from "./keys";
import { SIGNAL_KINDS } from "./kinds";
import {
  MemoryOutboxStore, SqliteOutboxStore,
  type OutboxKind, type OutboxStore,
} from "./outbox";
import { AmbientSyncScheduler } from "./sync-scheduler";
import {
  getAmbientTimelinePipeline,
  getAmbientTimelineStore,
  localEventIdsFromSignals,
  type AmbientTimelinePipeline,
} from "./timeline";
import { ActivitySource } from "./sources/activity";
import { CalendarSource } from "./sources/calendar";
import { DeviceStateSource } from "./sources/device-state";
import { FocusSource } from "./sources/focus";
import { HealthSource } from "./sources/health";
import { LocationSource } from "./sources/location";
import { AudioRouteSource } from "./sources/audio-route";
import { SoundClassifierSource } from "./sources/sound-classifier";
import type { AmbientSource, SourceContext } from "./sources/types";
import { VisitSource } from "./sources/visit";
import { maybeRunScheduledAmbientSummary } from "./timeline/scheduled-summary";
import { createCloudFirstAmbientSummaryBridge, createLocalAmbientSummaryBridge } from "./summary-bridges";
import { effectiveAmbientSummaryMode } from "./summary-preference";

export { ALL_SOURCE_KEYS, DEFAULT_AUTO_START_SOURCES };
export type { SourceKey };

export interface SourceStatus {
  key: SourceKey;
  label: string;
  enabled: boolean;
  lastEvent: { ts: number; summary: string } | null;
  ingestedCount: number;
  lastError: string | null;
}

export interface RuntimeStatus {
  sources: SourceStatus[];
  bufferSize: number;
  outboxMode: OutboxKind;
  outboxPendingCount: number;
  totalIngested: number;
  totalIngestErrors: number;
  lastFlushTs: number | null;
  lastDrainTs: number | null;
  lastSuccessfulDrainTs: number | null;
  lastIngestError: string | null;
  uploadsLocked: boolean;
}

export interface AmbientRuntimeOptions {
  sources?: AmbientSource[];
  outbox?: OutboxStore;
  scheduler?: AmbientSyncScheduler;
  timelinePipeline?: AmbientTimelinePipeline;
  enableTimers?: boolean;
  sourceWatchdogIntervalMs?: number;
  timelineSummaryIntervalMs?: number;
  contextSnapshotIntervalMs?: number;
}

const SOURCE_WATCHDOG_INTERVAL_MS = 60_000;
const TIMELINE_SUMMARY_INTERVAL_MS = 15 * 60_000;
const CONTEXT_SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const POWER_LOG_PREFIX = "[ambient-power]";

export class AmbientRuntime {
  private buffer: SignalBuffer;
  private outbox: OutboxStore;
  private scheduler: AmbientSyncScheduler;
  private timelinePipeline: AmbientTimelinePipeline;
  private sources: Map<SourceKey, AmbientSource>;
  private statusBySource: Map<SourceKey, SourceStatus>;
  private listeners = new Set<() => void>();
  private totalIngested = 0;
  private totalIngestErrors = 0;
  private lastFlushTs: number | null = null;
  private lastIngestError: string | null = null;
  private outboxPendingCount = 0;
  private autoStartInFlight = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private sourceWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private timelineSummaryTimer: ReturnType<typeof setInterval> | null = null;
  private contextSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  private timelineSummaryInFlight = false;
  private contextSnapshotInFlight = false;
  private sourceReconcilePromise: Promise<void> | null = null;
  private sourceReconcilePending = false;
  private desiredSourceKeys = new Set<SourceKey>();
  private optOutSources = loadOptOutSources();
  private transcriptionLanguage: string | null = null;

  constructor(options: AmbientRuntimeOptions = {}) {
    // SQLite persistence on native survives app kill / OS suspend so
    // outbox events queued under bad network don't get lost. Web build
    // keeps the in-memory store — SPA tab lifecycle is shorter and the
    // SQLite plugin's web path is heavy to set up.
    this.outbox = options.outbox ?? (isNative ? new SqliteOutboxStore() : new MemoryOutboxStore());
    this.scheduler = options.scheduler ?? new AmbientSyncScheduler(this.outbox, {
      ownerUserIdProvider: currentDeviceOwnerUserId,
      backendUrlProvider: () => PIN_API_BASE,
    });
    this.scheduler.setUploadsLocked(loadUploadsLocked());
    this.timelinePipeline = options.timelinePipeline ?? getAmbientTimelinePipeline();
    this.buffer = new SignalBuffer((batch) => this.flushBatch(batch));
    this.statusBySource = new Map();

    const ctx: SourceContext = {
      push: (item: PersonalSignalInput) => {
        void this.ingestLocalSignal(item).catch(() => {
          /* ingestLocalSignal records lastIngestError */
        });
      },
      pushDurable: (item: PersonalSignalInput) => this.ingestLocalSignal(item),
      onEvent: (key, summary) =>
        this.recordEvent(key as SourceKey, summary),
      getTranscriptionLanguage: () => this.transcriptionLanguage,
    };

    this.sources = new Map<SourceKey, AmbientSource>(
      (options.sources ?? [
        // Ask for platform data permissions before starting live audio capture,
        // otherwise the microphone path can dominate first-run onboarding.
        new HealthSource(ctx),
        new CalendarSource(ctx),
        new LocationSource(ctx),
        new VisitSource(ctx),
        new ActivitySource(ctx),
        new FocusSource(ctx),
        new SoundClassifierSource(ctx),
        new AudioRouteSource(ctx),
        new DeviceStateSource(ctx),
      ]).map((source) => [source.key as SourceKey, source]),
    );

    for (const [k, src] of this.sources) {
      this.statusBySource.set(k, {
        key: k,
        label: src.label,
        enabled: false,
        lastEvent: null,
        ingestedCount: 0,
        lastError: null,
      });
    }
    if (options.enableTimers !== false) {
      this.startDrainTimer();
      this.startTimelineSummaryTimer(options.timelineSummaryIntervalMs);
      this.startContextSnapshotTimer(options.contextSnapshotIntervalMs);
      this.startSourceWatchdog(options.sourceWatchdogIntervalMs);
    }
    console.info(`${POWER_LOG_PREFIX} runtime created`, {
      native: isNative,
      timersEnabled: options.enableTimers !== false,
      sources: Array.from(this.sources.keys()),
    });
  }

  async start(key: SourceKey): Promise<void> {
    const src = this.sources.get(key);
    if (!src) throw new Error(`unknown source: ${key}`);
    const st = this.statusBySource.get(key);
    if (!st) throw new Error(`missing status for: ${key}`);
    try {
      await src.start();
      this.optOutSources.delete(key);
      saveOptOutSources(this.optOutSources);
      st.enabled = true;
      st.lastError = null;
    } catch (err) {
      st.enabled = false;
      st.lastError = describeError(err);
      this.notify();
      throw err;
    }
    this.notify();
  }

  setTranscriptionLanguage(language: string | null | undefined): void {
    const normalized = language?.trim();
    this.transcriptionLanguage = normalized ? normalized : null;
  }

  async autoStart(keys: SourceKey[] = DEFAULT_AUTO_START_SOURCES): Promise<void> {
    if (this.autoStartInFlight) return;
    this.autoStartInFlight = true;
    try {
      for (const key of keys) {
        if (this.optOutSources.has(key)) continue;
        const st = this.statusBySource.get(key);
        if (st?.enabled) continue;
        try {
          await this.start(key);
        } catch {
          /* per-source errors are stored on SourceStatus */
        }
      }
    } finally {
      this.autoStartInFlight = false;
    }
  }

  async stop(key: SourceKey, opts: { remember?: boolean } = {}): Promise<void> {
    const src = this.sources.get(key);
    if (!src) throw new Error(`unknown source: ${key}`);
    const st = this.statusBySource.get(key);
    if (!st) throw new Error(`missing status for: ${key}`);
    try {
      await src.stop();
    } catch (err) {
      st.lastError = describeError(err);
    } finally {
      if (opts.remember !== false) {
        this.optOutSources.add(key);
        saveOptOutSources(this.optOutSources);
      }
      st.enabled = false;
      this.notify();
    }
  }

  async stopAll(): Promise<void> {
    console.info(`${POWER_LOG_PREFIX} stopAll ambient sources`);
    this.desiredSourceKeys.clear();
    for (const k of this.sources.keys()) {
      const st = this.statusBySource.get(k);
      if (st?.enabled) {
        try {
          await this.stop(k, { remember: false });
        } catch {
          /* swallow per source — best-effort shutdown */
        }
      }
    }
  }

  async shutdown(reason = "manual"): Promise<void> {
    console.info(`${POWER_LOG_PREFIX} runtime shutdown requested`, { reason });
    this.stopTimers(reason);
    await this.stopAll();
    await this.drain();
    this.listeners.clear();
  }

  async reconcileEnabledSources(keys: SourceKey[]): Promise<void> {
    this.desiredSourceKeys = new Set(keys.filter((key) => this.sources.has(key)));
    await this.reconcileDesiredSources();
  }

  async flush(): Promise<void> {
    await this.buffer.flush().catch((err) => {
      this.lastIngestError = describeError(err);
      this.notify();
    });
    await this.refreshOutboxCount();
  }

  async drain(): Promise<void> {
    await this.flush();
    const result = await this.scheduler.drain();
    this.totalIngested += result.inserted;
    this.totalIngestErrors += result.failed > 0 ? 1 : 0;
    this.recordIngestedItems(result.syncedItems);
    await this.markTimelineEventsSynced(result.syncedItems);
    this.lastIngestError = this.scheduler.status().lastError;
    await this.refreshOutboxCount();
    this.notify();
  }

  async refreshActiveSources(): Promise<void> {
    await this.reconcileDesiredSources();
  }

  async refreshContextSnapshot(now = new Date()): Promise<void> {
    try {
      const signal = await this.timelinePipeline.generateContextSnapshot(now);
      if (signal) {
        await this.outbox.enqueue([signal]);
        this.lastFlushTs = Date.now();
      }
      this.lastIngestError = null;
      await this.refreshOutboxCount();
    } catch (err) {
      this.lastIngestError = describeError(err);
      throw err;
    } finally {
      this.notify();
    }
  }

  async refreshTimeline(localDate?: string, options: { force?: boolean; forceReady?: boolean } = {}): Promise<void> {
    try {
      const signals = await this.timelinePipeline.regenerateDay(localDate, {
        includeRecentPending: true,
        forceReady: options.force === true,
        ...options,
      });
      if (signals.length > 0) {
        await this.outbox.enqueue(signals);
        this.lastFlushTs = Date.now();
      }
      this.lastIngestError = null;
      await this.refreshOutboxCount();
    } catch (err) {
      this.lastIngestError = describeError(err);
      throw err;
    } finally {
      this.notify();
    }
  }

  status(): RuntimeStatus {
    const schedulerStatus = this.scheduler.status();
    return {
      sources: Array.from(this.statusBySource.values()).map((s) => ({ ...s })),
      bufferSize: this.buffer.size(),
      outboxMode: this.outbox.kind,
      outboxPendingCount: this.outboxPendingCount,
      totalIngested: this.totalIngested,
      totalIngestErrors: this.totalIngestErrors,
      lastFlushTs: this.lastFlushTs,
      lastDrainTs: schedulerStatus.lastDrainTs,
      lastSuccessfulDrainTs: schedulerStatus.lastSuccessTs,
      lastIngestError: this.lastIngestError,
      uploadsLocked: schedulerStatus.uploadsLocked,
    };
  }

  setUploadsLocked(value: boolean): void {
    const next = !!value;
    if (this.scheduler.isUploadsLocked() === next) return;
    this.scheduler.setUploadsLocked(next);
    saveUploadsLocked(next);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async flushBatch(batch: PersonalSignalInput[]): Promise<void> {
    try {
      await this.outbox.enqueue(batch);
      this.lastFlushTs = Date.now();
      this.lastIngestError = null;
      await this.refreshOutboxCount();
    } catch (err) {
      this.lastIngestError = describeError(err);
      throw err;
    } finally {
      this.notify();
    }
  }

  private async ingestLocalSignal(item: PersonalSignalInput): Promise<void> {
    try {
      const timelineSignals = await this.timelinePipeline.ingestSignal(item);
      for (const signal of timelineSignals) {
        this.buffer.push(signal);
      }
      this.lastIngestError = null;
      await this.refreshOutboxCount();
    } catch (err) {
      this.lastIngestError = describeError(err);
      throw err;
    } finally {
      this.notify();
    }
  }

  private async markTimelineEventsSynced(
    items: PersonalSignalInput[],
  ): Promise<void> {
    const localEventIds = localEventIdsFromSignals(items);
    if (localEventIds.length === 0) return;
    try {
      const { getAmbientTimelineStore } = await import("./timeline");
      await getAmbientTimelineStore().markTimelineEventsSynced(localEventIds);
    } catch (err) {
      this.lastIngestError = describeError(err);
    }
  }

  private async refreshOutboxCount(): Promise<void> {
    this.outboxPendingCount = await this.outbox.count();
  }

  private recordIngestedItems(items: PersonalSignalInput[]): void {
    if (items.length === 0) return;
    const byKind = countByKind(items);
    const soundCount =
      (byKind.get(SIGNAL_KINDS.soundClassification) ?? 0) +
      (byKind.get("session_summary") ?? 0);
    for (const st of this.statusBySource.values()) {
      const c = st.key === "sound_classifier"
        ? soundCount
        : byKind.get(SOURCE_TO_KIND[st.key]) ?? 0;
      if (c > 0) st.ingestedCount += c;
    }
  }

  private recordEvent(key: SourceKey, summary: string): void {
    const st = this.statusBySource.get(key);
    if (!st) return;
    st.lastEvent = { ts: Date.now(), summary };
    this.notify();
  }

  private startDrainTimer(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      void this.drain();
    }, this.scheduler.intervalMs());
    console.info(`${POWER_LOG_PREFIX} drain timer started`, {
      intervalMs: this.scheduler.intervalMs(),
    });
  }

  private startTimelineSummaryTimer(intervalMs = TIMELINE_SUMMARY_INTERVAL_MS): void {
    if (this.timelineSummaryTimer) return;
    this.timelineSummaryTimer = setInterval(() => {
      void this.runScheduledTimelineSummary();
    }, intervalMs);
    console.info(`${POWER_LOG_PREFIX} timeline summary timer started`, { intervalMs });
  }

  private startContextSnapshotTimer(intervalMs = CONTEXT_SNAPSHOT_INTERVAL_MS): void {
    if (this.contextSnapshotTimer) return;
    this.contextSnapshotTimer = setInterval(() => {
      void this.runScheduledContextSnapshot();
    }, intervalMs);
    console.info(`${POWER_LOG_PREFIX} context snapshot timer started`, { intervalMs });
  }

  private async runScheduledContextSnapshot(): Promise<void> {
    if (this.contextSnapshotInFlight) return;
    this.contextSnapshotInFlight = true;
    try {
      await this.refreshContextSnapshot();
    } finally {
      this.contextSnapshotInFlight = false;
    }
  }

  async runScheduledTimelineSummary(nowOverride?: Date): Promise<void> {
    if (this.timelineSummaryInFlight) return;
    this.timelineSummaryInFlight = true;
    try {
      const now = nowOverride ?? new Date();
      const localDate = now.toISOString().slice(0, 10);
      const uploadsLockedAtStart = this.scheduler.isUploadsLocked();
      const bridge = effectiveAmbientSummaryMode({ uploadsLocked: uploadsLockedAtStart }) === "cloud_llm"
        ? createCloudFirstAmbientSummaryBridge({
          shouldUseCloud: () => !this.scheduler.isUploadsLocked(),
        })
        : createLocalAmbientSummaryBridge();
      const localUserId = await currentDeviceOwnerUserId();
      const result = await maybeRunScheduledAmbientSummary({
        store: getAmbientTimelineStore(),
        bridge,
        now,
        localDate,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        localUserId: localUserId ?? "local",
        shouldPersistResult: (summaryResult) => (
          summaryResult.generationMethod !== "cloud_llm" || !this.scheduler.isUploadsLocked()
        ),
      });
      if (result.ran && result.status === "success") {
        await this.refreshTimeline(localDate);
      }
    } finally {
      this.timelineSummaryInFlight = false;
    }
  }

  private startSourceWatchdog(intervalMs = SOURCE_WATCHDOG_INTERVAL_MS): void {
    if (!isNative || this.sourceWatchdogTimer) return;
    this.sourceWatchdogTimer = setInterval(() => {
      void this.refreshActiveSources();
    }, intervalMs);
    console.info(`${POWER_LOG_PREFIX} source watchdog started`, { intervalMs });
  }

  private stopTimers(reason: string): void {
    let stopped = 0;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
      stopped += 1;
    }
    if (this.timelineSummaryTimer) {
      clearInterval(this.timelineSummaryTimer);
      this.timelineSummaryTimer = null;
      stopped += 1;
    }
    if (this.sourceWatchdogTimer) {
      clearInterval(this.sourceWatchdogTimer);
      this.sourceWatchdogTimer = null;
      stopped += 1;
    }
    if (this.contextSnapshotTimer) {
      clearInterval(this.contextSnapshotTimer);
      this.contextSnapshotTimer = null;
      stopped += 1;
    }
    console.info(`${POWER_LOG_PREFIX} runtime timers stopped`, { reason, stopped });
  }

  private async reconcileDesiredSources(): Promise<void> {
    if (this.sourceReconcilePromise) {
      this.sourceReconcilePending = true;
      return this.sourceReconcilePromise;
    }
    const promise = this.runReconcileDesiredSources();
    this.sourceReconcilePromise = promise;
    try {
      await promise;
    } finally {
      if (this.sourceReconcilePromise === promise) {
        this.sourceReconcilePromise = null;
      }
    }
  }

  private async runReconcileDesiredSources(): Promise<void> {
    try {
      do {
        this.sourceReconcilePending = false;
        for (const [key, src] of this.sources) {
          const st = this.statusBySource.get(key);
          if (!st) continue;
          const shouldRun = this.desiredSourceKeys.has(key);
          if (!shouldRun) {
            if (st.enabled || src.isStarted()) {
              try {
                await this.stop(key, { remember: false });
              } catch {
                /* stop() records per-source errors */
              }
            }
            continue;
          }

          if (!st.enabled || !src.isStarted()) {
            try {
              await this.start(key);
            } catch {
              /* start() records per-source errors */
            }
            continue;
          }

          if (typeof src.refresh !== "function") continue;
          try {
            await src.refresh();
            st.lastError = null;
          } catch (err) {
            st.lastError = describeError(err);
          }
        }
      } while (this.sourceReconcilePending);
    } finally {
      this.notify();
    }
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

const SOURCE_TO_KIND: Record<SourceKey, string> = {
  sound_classifier: SIGNAL_KINDS.soundClassification,
  visit: SIGNAL_KINDS.visit,
  activity: SIGNAL_KINDS.activity,
  location: SIGNAL_KINDS.location,
  health: "health.observation",
  calendar: SIGNAL_KINDS.calendarEvent,
  focus: SIGNAL_KINDS.focusState,
  audio_route: SIGNAL_KINDS.audioRoute,
  device_state: SIGNAL_KINDS.deviceState,
};

const OPT_OUT_STORAGE_KEY = "pin.ambient.optOutSources";
const UPLOADS_LOCKED_STORAGE_KEY = "pin.ambient.uploadsLocked";

function loadUploadsLocked(): boolean {
  try {
    return localStorage.getItem(UPLOADS_LOCKED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveUploadsLocked(locked: boolean): void {
  try {
    if (locked) {
      localStorage.setItem(UPLOADS_LOCKED_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(UPLOADS_LOCKED_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function loadOptOutSources(): Set<SourceKey> {
  try {
    const raw = localStorage.getItem(OPT_OUT_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(isSourceKey));
  } catch {
    return new Set();
  }
}

function saveOptOutSources(sources: Set<SourceKey>): void {
  try {
    localStorage.setItem(OPT_OUT_STORAGE_KEY, JSON.stringify(Array.from(sources)));
  } catch {
    /* ignore */
  }
}

function isSourceKey(value: unknown): value is SourceKey {
  return typeof value === "string" && ALL_SOURCE_KEYS.includes(value as SourceKey);
}

function countByKind(items: PersonalSignalInput[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    m.set(it.kind, (m.get(it.kind) ?? 0) + 1);
  }
  return m;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

let singleton: AmbientRuntime | null = null;

export function getAmbientRuntime(): AmbientRuntime {
  if (!singleton) singleton = new AmbientRuntime();
  return singleton;
}

export function getExistingAmbientRuntime(): AmbientRuntime | null {
  return singleton;
}

export async function shutdownAmbientRuntime(reason = "manual"): Promise<void> {
  const runtime = singleton;
  if (!runtime) {
    console.info(`${POWER_LOG_PREFIX} runtime shutdown skipped`, { reason, runtime: "none" });
    return;
  }
  singleton = null;
  await runtime.shutdown(reason);
}
