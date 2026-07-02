/**
 * Ambient 运行时（RN）：source 生命周期 + ingest loop。开关 = 本地
 * opt-in（AsyncStorage，per-device 授权语义与 Capacitor 版一致：本机没
 * 显式打开就绝不采集）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AmbientLifecycleController, type AmbientStartSession } from "@pin-ai/core";

import {
  flushSignals,
  pushSignal,
  refreshOutboxCount,
  startIngestLoop,
  stopIngestLoop,
} from "./ingest";
import { createActivitySource } from "./sources/activity";
import { createAudioRouteSource } from "./sources/audio-route";
import { createCalendarSource } from "./sources/calendar";
import { createDeviceStateSource } from "./sources/device-state";
import { createFocusSource } from "./sources/focus";
import { createHealthSource } from "./sources/health";
import { createLocationSource } from "./sources/location";
import { createSoundClassifierSource } from "./sources/sound-classifier";
import { createVisitSource } from "./sources/visit";
import type { AmbientSource, PersonalSignalInput, SourceContext } from "./types";
import { getAmbientTimelinePipeline } from "./timeline";
import {
  clearSourceError,
  describeError,
  getAggregate,
  getPerSourceTelemetry,
  notifyStatus,
  recordSourceError,
  recordSourceEvent,
  subscribeStatus,
  type RuntimeStatus,
} from "./status";

const ENABLED_KEY = "pinai:ambient-enabled";
const SOURCE_START_TIMEOUT_MS = 8_000;

// 生命周期标记只打 log，不当数据事件计数；真实捕获摘要才进遥测（lastEvent + 计数）。
const LIFECYCLE_MARKERS = new Set(["starting", "started", "stopping", "stopped"]);

// 把每条采集信号也写进本地 timeline store（= dev on-device 架构）：ingestSignal 先
// upsertRawEvent（raw event 落库 → live 卡 replay 转写 + context chips + timeline 原始条目），
// 再窗口化 + 端侧生成。LLM 生成缺 llama 会失败，但 raw event 已先落库、不影响 live/context；
// fire-and-forget，不阻塞上传。
async function ingestToTimelineStore(item: PersonalSignalInput): Promise<void> {
  try {
    await getAmbientTimelinePipeline().ingestSignal(item);
  } catch (err) {
    console.warn("[ambient] timeline store ingest failed:", err);
  }
}

const ctx: SourceContext = {
  push: (item) => {
    pushSignal(item); // 上传 outbox（服务端）
    void ingestToTimelineStore(item); // 写本地 store（喂 live 卡 + timeline）
  },
  onEvent: (key, summary) => {
    console.log(`[ambient:${key}] ${summary}`);
    if (!LIFECYCLE_MARKERS.has(summary)) recordSourceEvent(key, summary);
  },
};

const lifecycle = new AmbientLifecycleController();

const sources: AmbientSource[] = [
  createLocationSource(ctx),
  createDeviceStateSource(ctx),
  createSoundClassifierSource(ctx),
  createAudioRouteSource(ctx),
  createCalendarSource(ctx),
  createHealthSource(ctx),
  createVisitSource(ctx),
  createActivitySource(ctx),
  createFocusSource(ctx),
];

let startPromise: Promise<string[]> | null = null;
let startPromiseSession: AmbientStartSession | null = null;

interface StartAmbientOptions {
  interactivePermissions?: boolean;
}

// ── 本机 opt-in 闸的共享可订阅镜像 ──
// dev 用同步 localStorage + useUserSettings fan-out 让 NOW / Ambient 两处开关共享同一值。
// RN 的 AsyncStorage 是异步的，这里用一个内存镜像 + 订阅集补上「fan-out」，让两处
// useAmbientToggle 读到同一个闸、任一处翻转都同步（否则各存各的 local state 会 desync）。
let enabledSnapshot: boolean | null = null; // null = 还没读过 AsyncStorage
const enabledListeners = new Set<() => void>();

function setEnabledSnapshot(enabled: boolean): void {
  if (enabledSnapshot === enabled) return;
  enabledSnapshot = enabled;
  for (const listener of enabledListeners) listener();
}

/** 改本机闸的唯一入口：写 AsyncStorage + 更新镜像 + 通知订阅者（所有改闸处都走这里）。 */
async function writeEnabledFlag(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  setEnabledSnapshot(enabled);
}

/** useSyncExternalStore 订阅端（两处开关共享）。 */
export function subscribeAmbientEnabled(callback: () => void): () => void {
  enabledListeners.add(callback);
  return () => {
    enabledListeners.delete(callback);
  };
}

/** useSyncExternalStore 快照端（null = 还没读到，UI 先按 off 渲染）。 */
export function getAmbientEnabledSnapshot(): boolean | null {
  return enabledSnapshot;
}

/** 乐观翻转本机 opt-in 闸（只写闸 + 通知，不启停 sources）——toggle 先调它让 UI 立刻反应。 */
export async function setAmbientEnabledFlag(enabled: boolean): Promise<void> {
  await writeEnabledFlag(enabled);
}

export async function isAmbientEnabled(): Promise<boolean> {
  const enabled = (await AsyncStorage.getItem(ENABLED_KEY)) === "1";
  setEnabledSnapshot(enabled);
  return enabled;
}

export async function startAmbient(
  userId: string,
  opts: StartAmbientOptions = {},
): Promise<string[]> {
  if (lifecycle.runningFor(userId)) return lifecycle.startedSourceKeys;
  if (startPromise && lifecycle.ownerUserId === userId) return startPromise;
  if (lifecycle.running || startPromise) await stopAmbient();
  const session = lifecycle.beginStart(userId, opts.interactivePermissions ?? true);
  startPromiseSession = session;
  startPromise = startAmbientSources(session).finally(() => {
    if (startPromiseSession?.id === session.id) {
      startPromise = null;
      startPromiseSession = null;
    }
  });
  return startPromise;
}

async function startAmbientSources(session: AmbientStartSession): Promise<string[]> {
  await writeEnabledFlag(true);
  if (!lifecycle.isCurrentStart(session)) return [];
  startIngestLoop(session.userId);
  const started: string[] = [];
  for (const s of sources) {
    if (!lifecycle.isCurrentStart(session)) break;
    try {
      ctx.onEvent(s.key, "starting");
      const status = await startSourceForSession(session, s);
      if (status === "cancelled") break;
      started.push(s.key);
      ctx.onEvent(s.key, "started");
    } catch (err) {
      // 单源权限被拒不影响其他源（与 web startAmbientUpload 同语义）。
      console.warn(`[ambient] ${s.key} failed to start:`, err);
    }
  }
  const result = lifecycle.completeStart(session, started);
  if (result !== "started") {
    await writeEnabledFlag(false);
    stopIngestLoop();
  }
  return result === "started" ? started : [];
}

export async function stopAmbient(): Promise<void> {
  await writeEnabledFlag(false);
  lifecycle.stop();
  startPromise = null;
  startPromiseSession = null;
  for (const s of sources) {
    await s.stop().catch(() => {});
  }
  stopIngestLoop();
}

export function ambientRunning(): boolean {
  return lifecycle.running;
}

/** 登录后恢复：本机此前显式开过才自动续采。 */
export async function resumeAmbientIfEnabled(userId: string): Promise<void> {
  if (await isAmbientEnabled()) {
    await startAmbient(userId, { interactivePermissions: false });
  }
}

// ── per-source reconcile + 遥测快照（settings Permissions & sources 面板用）──

/**
 * 把"正在跑的源集合"调和到 desiredKeys（consent 真集）。web AmbientRuntime
 * .reconcileEnabledSources 的 RN 对应物：desired&&未跑→启，未 desired&&在跑→停。
 * ≥1 desired 时确保 ingest loop 在跑、本机 opt-in；全停时关 loop + opt-out。
 * 与 master 开关（startAmbient）共享同一 sources 数组，按 isStarted() 收口真相。
 */
export async function reconcileEnabledSources(userId: string, keys: string[]): Promise<void> {
  const desired = new Set(keys);
  if (desired.size > 0) {
    await writeEnabledFlag(true);
    startIngestLoop(userId);
  }
  for (const s of sources) {
    const shouldRun = desired.has(s.key);
    if (shouldRun && !s.isStarted()) {
      try {
        ctx.onEvent(s.key, "starting");
        await s.start({ interactivePermissions: true });
        clearSourceError(s.key);
        ctx.onEvent(s.key, "started");
      } catch (err) {
        // 单源失败（权限拒绝/超时）不影响其他源，错误进遥测让面板显示。
        recordSourceError(s.key, describeError(err));
      }
    } else if (!shouldRun && s.isStarted()) {
      await s.stop().catch(() => {});
    }
  }
  const startedKeys = sources.filter((s) => s.isStarted()).map((s) => s.key);
  const running = startedKeys.length > 0;
  // 收口 lifecycle 视图，ambientRunning()/startedSourceKeys 保持真相。
  lifecycle.running = running;
  lifecycle.ownerUserId = running ? userId : null;
  lifecycle.startedSourceKeys = startedKeys;
  if (!running) {
    await writeEnabledFlag(false);
    stopIngestLoop();
  }
  await refreshOutboxCount();
  notifyStatus();
}

/**
 * 立即把 outbox drain 到网络（面板 Flush 钮）。web 的 flush 是 buffer→outbox，
 * RN 无内存 buffer → 这里直接 drain（= web 的 drain 语义）。
 */
export async function flushAmbient(): Promise<void> {
  await flushSignals();
  await refreshOutboxCount();
}

/** 当前 RuntimeStatus 快照（per-source running 现读 isStarted() = 真相）。 */
export function ambientStatusSnapshot(): RuntimeStatus {
  const agg = getAggregate();
  return {
    sources: sources.map((s) => {
      const t = getPerSourceTelemetry(s.key);
      return {
        key: s.key,
        label: s.label,
        enabled: s.isStarted(),
        lastEvent: t?.lastEvent ?? null,
        ingestedCount: t?.ingestedCount ?? 0,
        lastError: t?.lastError ?? null,
      };
    }),
    bufferSize: 0,
    outboxMode: "sqlite",
    outboxPendingCount: agg.outboxPendingCount,
    totalIngested: agg.totalIngested,
    totalIngestErrors: agg.totalIngestErrors,
    lastFlushTs: agg.lastFlushTs,
    lastDrainTs: agg.lastDrainTs,
    lastSuccessfulDrainTs: agg.lastSuccessfulDrainTs,
    lastIngestError: agg.lastIngestError,
    uploadsLocked: agg.uploadsLocked,
  };
}

/** 订阅遥测变更（面板 useEffect 用，返回退订函数）。 */
export function subscribeAmbientStatus(listener: () => void): () => void {
  return subscribeStatus(listener);
}

async function startSourceForSession(
  session: AmbientStartSession,
  source: AmbientSource,
): Promise<"started" | "cancelled"> {
  let settled = false;
  const startTask = source
    .start({
      interactivePermissions: lifecycle.interactivePermissions,
    })
    .finally(() => {
      settled = true;
    });
  try {
    await withTimeout(startTask, SOURCE_START_TIMEOUT_MS, source.key);
  } catch (err) {
    if (!settled) {
      void startTask.then(
        () => void source.stop().catch(() => {}),
        () => {},
      );
    }
    throw err;
  }
  if (!lifecycle.isCurrentStart(session)) {
    await source.stop().catch(() => {});
    return "cancelled";
  }
  return "started";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  key: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${key} start timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
