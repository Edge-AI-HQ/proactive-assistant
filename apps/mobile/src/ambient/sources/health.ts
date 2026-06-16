/**
 * Health 源（RN 直替：@kingstinct/react-native-healthkit v14/Nitro 覆盖
 * Swift health 监听）。查询式（15 分钟周期）替代原推送式；三 metric 的
 * 信号形状与 web sources/health.ts 完全对齐——dedupe_key 同构
 * （ios:health:<metric>:…），迁移期与 Capacitor 版并存也不会双写。
 */
import {
  AuthorizationRequestStatus,
  getRequestStatusForAuthorization,
  isHealthDataAvailableAsync,
  queryCategorySamples,
  queryQuantitySamples,
  queryStatisticsForQuantity,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";

import {
  type AmbientSource,
  type AmbientSourceStartOptions,
  type SourceContext,
} from "../types";

const HEALTH_KIND = "health.observation";
const SCHEMA_VERSION = "health_observation.v1";
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const HEALTH_READ_TYPES = [
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierHeartRate",
  "HKCategoryTypeIdentifierSleepAnalysis",
] as const;

function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ts: number): Date {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function createHealthSource(ctx: SourceContext): AmbientSource {
  let timer: ReturnType<typeof setInterval> | null = null;

  function push(args: {
    metric: "steps" | "sleep" | "heart_rate";
    observationType: "daily_summary" | "session" | "window_summary";
    value: number;
    unit: "count" | "minute" | "bpm";
    title: string;
    summary: string;
    occurredAt: string;
    startAt: string;
    dedupeKey: string;
    syncMode: "incremental" | "full";
  }): void {
    ctx.push({
      kind: HEALTH_KIND,
      sync_mode: args.syncMode,
      title: args.title,
      summary: args.summary,
      occurred_at: args.occurredAt,
      dedupe_key: args.dedupeKey,
      payload: {
        schema_version: SCHEMA_VERSION,
        observation_type: args.observationType,
        metric: args.metric,
        value: args.value,
        unit: args.unit,
        local_date: localDate(Date.parse(args.occurredAt)),
        source_app: "healthkit",
        occurred_at: args.occurredAt,
        start_at: args.startAt,
        end_at: args.occurredAt,
        dedupe_key: args.dedupeKey,
      },
    });
    ctx.onEvent("health", args.summary);
  }

  async function scanSteps(now: number): Promise<void> {
    const stats = await queryStatisticsForQuantity(
      "HKQuantityTypeIdentifierStepCount",
      ["cumulativeSum"],
      { filter: { date: { startDate: startOfDay(now), endDate: new Date(now) } }, unit: "count" },
    );
    const value = Math.round(stats.sumQuantity?.quantity ?? 0);
    if (value <= 0) return;
    push({
      metric: "steps",
      observationType: "daily_summary",
      value,
      unit: "count",
      title: "Daily steps",
      summary: `${value} steps today`,
      occurredAt: new Date(now).toISOString(),
      startAt: startOfDay(now).toISOString(),
      dedupeKey: `ios:health:steps:${localDate(now)}`,
      syncMode: "full",
    });
  }

  async function scanHeartRate(now: number): Promise<void> {
    const samples = await queryQuantitySamples("HKQuantityTypeIdentifierHeartRate", {
      filter: { date: { startDate: new Date(now - SIX_HOURS_MS), endDate: new Date(now) } },
      unit: "count/min",
      limit: 200,
    });
    if (samples.length === 0) return;
    const avg = samples.reduce((acc, s) => acc + s.quantity, 0) / samples.length;
    const value = Math.round(avg);
    if (value <= 0) return;
    push({
      metric: "heart_rate",
      observationType: "window_summary",
      value,
      unit: "bpm",
      title: "Heart rate",
      summary: `${value} bpm avg over 6h`,
      occurredAt: new Date(now).toISOString(),
      startAt: new Date(now - SIX_HOURS_MS).toISOString(),
      dedupeKey: `ios:health:heart_rate:${localDate(now)}:${now}`,
      syncMode: "full",
    });
  }

  async function scanSleep(now: number): Promise<void> {
    // 昨晚窗口：18:00 起到现在的 asleep 段累计。
    const windowStart = new Date(startOfDay(now).getTime() - 6 * 60 * 60 * 1000);
    const samples = await queryCategorySamples("HKCategoryTypeIdentifierSleepAnalysis", {
      filter: { date: { startDate: windowStart, endDate: new Date(now) } },
      limit: 200,
    });
    // value: 0=inBed, 1=asleepUnspecified, 3/4/5=asleep core/deep/REM。
    const asleep = samples.filter((s) => s.value >= 1 && s.value !== 2);
    if (asleep.length === 0) return;
    let totalMin = 0;
    let endedAtMs = 0;
    for (const s of asleep) {
      const start = new Date(s.startDate).getTime();
      const end = new Date(s.endDate).getTime();
      totalMin += (end - start) / 60_000;
      endedAtMs = Math.max(endedAtMs, end);
    }
    const value = Math.round(totalMin);
    if (value <= 0) return;
    const endedAtIso = new Date(endedAtMs).toISOString();
    push({
      metric: "sleep",
      observationType: "session",
      value,
      unit: "minute",
      title: "Sleep session",
      summary: `${value} min sleep session`,
      occurredAt: endedAtIso,
      startAt: new Date(endedAtMs - value * 60_000).toISOString(),
      dedupeKey: `ios:health:sleep:${endedAtIso}`,
      syncMode: "incremental",
    });
  }

  async function scan(): Promise<void> {
    const now = Date.now();
    // 各 metric 独立失败（权限按类型细分，某类被拒不影响其他）。
    await scanSteps(now).catch(() => {});
    await scanHeartRate(now).catch(() => {});
    await scanSleep(now).catch(() => {});
  }

  async function ensureAuthorization(options?: AmbientSourceStartOptions): Promise<void> {
    const request = { toRead: HEALTH_READ_TYPES };
    const status = await getRequestStatusForAuthorization(request);
    if (status === AuthorizationRequestStatus.unnecessary) return;
    if (options?.interactivePermissions === false) {
      throw new Error("health authorization requires user prompt");
    }
    await requestAuthorization(request);
  }

  return {
    key: "health",
    label: "HealthKit",
    isStarted: () => timer !== null,
    async start(options?: AmbientSourceStartOptions) {
      if (timer) return;
      if (!(await isHealthDataAvailableAsync())) throw new Error("HealthKit unavailable");
      await ensureAuthorization(options);
      await scan();
      timer = setInterval(() => void scan(), SCAN_INTERVAL_MS);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh: scan,
  };
}
