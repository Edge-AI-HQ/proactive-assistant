import {
  AmbientAi,
  type HeartRateEvent,
  type SleepEvent,
  type StepsEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import type { PersonalSignalInput } from "@/lib/devices";
import type { AmbientSource, SourceContext } from "./types";

const HEALTH_KIND = "health.observation";
const SCHEMA_VERSION = "health_observation.v1";
const SOURCE_APP = "healthkit";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

type HealthMetric = "steps" | "sleep" | "heart_rate";

interface HealthObservation {
  schema_version: typeof SCHEMA_VERSION;
  observation_type: "daily_summary" | "session" | "window_summary";
  metric: HealthMetric;
  value: number;
  unit: "count" | "minute" | "bpm";
  local_date: string;
  source_app: typeof SOURCE_APP;
  occurred_at: string;
  dedupe_key: string;
  start_at?: string;
  end_at?: string;
}

export class HealthSource implements AmbientSource {
  readonly key = "health";
  readonly label = "HealthKit";

  private listenerHandles: PluginListenerHandle[] = [];
  private started = false;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const perm = await AmbientAi.health.requestPermissions();
    if (perm.health !== "granted") {
      throw new Error(`health permission ${perm.health}`);
    }

    this.listenerHandles = await Promise.all([
      AmbientAi.addListener("steps", (event) => this.handleSteps(event)),
      AmbientAi.addListener("sleep", (event) => this.handleSleep(event)),
      AmbientAi.addListener("heartRate", (event) => this.handleHeartRate(event)),
    ]);

    try {
      await AmbientAi.health.startMonitoring();
      this.started = true;
    } catch (err) {
      await this.removeListeners();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && this.listenerHandles.length === 0) return;
    try {
      await AmbientAi.health.stopMonitoring();
    } finally {
      await this.removeListeners();
      this.started = false;
    }
  }

  async refresh(): Promise<void> {
    if (!this.started) return;
    await AmbientAi.health.startMonitoring();
  }

  handleStepsForTest(event: StepsEvent): void {
    this.handleSteps(event);
  }

  handleSleepForTest(event: SleepEvent): void {
    this.handleSleep(event);
  }

  handleHeartRateForTest(event: HeartRateEvent): void {
    this.handleHeartRate(event);
  }

  private handleSteps(event: StepsEvent): void {
    if (!Number.isFinite(event.stepsToday)) return;
    const value = Math.max(0, Math.round(event.stepsToday));
    const occurredAt = new Date(event.timestamp).toISOString();
    const localDate = formatLocalDate(event.timestamp);
    const dedupeKey = `ios:health:steps:${localDate}`;
    const observation: HealthObservation = {
      schema_version: SCHEMA_VERSION,
      observation_type: "daily_summary",
      metric: "steps",
      value,
      unit: "count",
      local_date: localDate,
      source_app: SOURCE_APP,
      occurred_at: occurredAt,
      start_at: startOfLocalDayIso(event.timestamp),
      end_at: occurredAt,
      dedupe_key: dedupeKey,
    };
    const summary = `${value} steps today`;
    this.pushObservation({
      metric: "steps",
      syncMode: "full",
      title: "Daily steps",
      summary,
      occurredAt,
      localDate,
      dedupeKey,
      observation,
    });
    this.ctx.onEvent(this.key, summary);
  }

  private handleSleep(event: SleepEvent): void {
    if (!Number.isFinite(event.durationMin) || event.durationMin <= 0) return;
    const value = Math.round(event.durationMin);
    const endedAtMs = Date.parse(event.endedAt);
    if (!Number.isFinite(endedAtMs)) return;
    const occurredAt = new Date(endedAtMs).toISOString();
    const localDate = formatLocalDate(endedAtMs);
    const dedupeKey = `ios:health:sleep:${event.endedAt}`;
    const observation: HealthObservation = {
      schema_version: SCHEMA_VERSION,
      observation_type: "session",
      metric: "sleep",
      value,
      unit: "minute",
      local_date: localDate,
      source_app: SOURCE_APP,
      occurred_at: occurredAt,
      start_at: new Date(endedAtMs - value * 60_000).toISOString(),
      end_at: occurredAt,
      dedupe_key: dedupeKey,
    };
    const summary = `${value} min sleep session`;
    this.pushObservation({
      metric: "sleep",
      syncMode: "incremental",
      title: "Sleep session",
      summary,
      occurredAt,
      localDate,
      dedupeKey,
      observation,
    });
    this.ctx.onEvent(this.key, summary);
  }

  private handleHeartRate(event: HeartRateEvent): void {
    if (!Number.isFinite(event.avgBpm6h) || event.avgBpm6h <= 0) return;
    const value = Math.round(event.avgBpm6h);
    const occurredAt = new Date(event.timestamp).toISOString();
    const localDate = formatLocalDate(event.timestamp);
    const dedupeKey = `ios:health:heart_rate:${localDate}:${event.timestamp}`;
    const observation: HealthObservation = {
      schema_version: SCHEMA_VERSION,
      observation_type: "window_summary",
      metric: "heart_rate",
      value,
      unit: "bpm",
      local_date: localDate,
      source_app: SOURCE_APP,
      occurred_at: occurredAt,
      start_at: new Date(event.timestamp - SIX_HOURS_MS).toISOString(),
      end_at: occurredAt,
      dedupe_key: dedupeKey,
    };
    const summary = `${value} bpm avg over 6h`;
    this.pushObservation({
      metric: "heart_rate",
      syncMode: "full",
      title: "Heart rate",
      summary,
      occurredAt,
      localDate,
      dedupeKey,
      observation,
    });
    this.ctx.onEvent(this.key, summary);
  }

  private pushObservation(args: {
    metric: HealthMetric;
    syncMode: "incremental" | "full";
    title: string;
    summary: string;
    occurredAt: string;
    localDate: string;
    dedupeKey: string;
    observation: HealthObservation;
  }): void {
    const item: PersonalSignalInput = {
      id: `${args.dedupeKey}:${Date.parse(args.occurredAt)}`,
      kind: HEALTH_KIND,
      sync_mode: args.syncMode,
      title: args.title,
      summary: args.summary,
      occurred_at: args.occurredAt,
      payload: {
        schema_version: SCHEMA_VERSION,
        source_app: SOURCE_APP,
        metric: args.metric,
        local_date: args.localDate,
        observations: [args.observation],
      },
      dedupe_key: `${args.dedupeKey}:event:${Date.parse(args.occurredAt)}`,
    };
    this.ctx.push(item);
  }

  private async removeListeners(): Promise<void> {
    const handles = this.listenerHandles;
    this.listenerHandles = [];
    await Promise.all(handles.map((handle) => handle.remove()));
  }
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDayIso(timestamp: number): string {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}
