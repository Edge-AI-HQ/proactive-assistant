/**
 * Ambient 运行时（RN）：source 生命周期 + ingest loop。开关 = 本地
 * opt-in（AsyncStorage，per-device 授权语义与 Capacitor 版一致：本机没
 * 显式打开就绝不采集）。
 *
 * 对齐 dev AmbientRuntime（services/ambient/index.ts）的关键语义：
 *  - **方案 A（2026-07-01，dev ingestLocalSignal 同款）：手机是哑采集器**——各
 *    source 原始信号直接进上传 outbox（入队落盘后立即 drain，事件级实时上报），
 *    不再走本地 timeline pipeline 聚合 candidate_window、不做本地 LLM summary。
 *    聚合/去噪/摘要全部下沉后端 memory 架构：kind 三端 SSOT（core SIGNAL_KINDS）
 *    ↔ 后端 device_ingest/recipes.py → pai_raw_device（L0）→ projector 实时投
 *    pai_events（L1）。Live 卡实时转写走独立 live-transcript-store，不受影响。
 *  - boot 恢复按 server per-source consent 决定启哪些源（dev App.tsx:77-133
 *    "which sources start follows the server consent, not all of them"）。
 *  - 60s source watchdog（refreshActiveSources）随采集生命周期起停；15min
 *    context snapshot + 15min scheduled summary 两个本地聚合定时器已随方案 A
 *    停掉（dev index.ts:167-171 同款，函数保留、恢复时取消注释）。
 *  - AppState 前台 → reconcile + drain，切后台 → 最后 drain 一次（dev
 *    lifecycle.ts bindAmbientLifecycle）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import {
  AmbientLifecycleController,
  effectiveAmbientSummaryMode,
  maybeRunScheduledAmbientSummary,
  proxyFetch,
  type AmbientStartSession,
} from "@pin-ai/core";

import {
  flushSignals,
  pushSignal,
  pushSignalAndFlush,
  refreshOutboxCount,
  startIngestLoop,
  stopIngestLoop,
  uploadsLockedSnapshot,
} from "./ingest";
import { AMBIENT_SOURCE_KEYS } from "./keys";
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
import { getAmbientTimelinePipeline, refreshTimeline } from "./timeline";
import { getAmbientTimelineStore } from "./timeline/store";
import { createCloudFirstAmbientSummaryBridge, createLocalAmbientSummaryBridge } from "./summary-bridges";
import { loadAmbientSummaryPreference } from "./summary-preference";
import {
  clearSourceError,
  describeError,
  getAggregate,
  getPerSourceTelemetry,
  notifyStatus,
  recordSourceError,
  recordSourceEvent,
  setLastIngestError,
  subscribeStatus,
  type RuntimeStatus,
} from "./status";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount, probeSet } from "../lib/heat-probe";

const ENABLED_KEY = "pinai:ambient-enabled";
const SOURCE_START_TIMEOUT_MS = 8_000;
const SOURCE_WATCHDOG_INTERVAL_MS = 60_000;
const TIMELINE_SUMMARY_INTERVAL_MS = 15 * 60_000;
const CONTEXT_SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const POWER_LOG_PREFIX = "[ambient-power]";

// 生命周期标记只打 log，不当数据事件计数；真实捕获摘要才进遥测（lastEvent + 计数）。
const LIFECYCLE_MARKERS = new Set(["starting", "started", "stopping", "stopped"]);

// 方案 A（2026-07-01，dev index.ts ingestLocalSignal 同款）：手机是哑采集器。
// 各 source 原始信号**直接**进 durable outbox 上报（kind 与后端
// device_ingest/recipes.py 的 DEVICE_RECIPES 一一对应：session_summary→utterance、
// visit→visit、motion_segment→motion、location/activity/sound→context…），不再
// 经本地 timeline pipeline 蒸馏——此前只上传蒸馏产物（ambient.timeline_event /
// ambient.candidate_window），导致 RN 用户的原始 ambient 数据进不了
// pai_raw_device / pai_events（2026-07-07 审计修复）。

// Ambient 转写语言 hint（= dev runtime.transcriptionLanguage）：settings.
// generationLanguage 经 useAmbientToggle / useAmbientConsentReconcile 写入，
// sound-classifier 读它派生 recognitionLocale + ?language=。
let transcriptionLanguage: string | null = null;

export function setAmbientTranscriptionLanguage(language: string | null | undefined): void {
  const normalized = language?.trim();
  transcriptionLanguage = normalized ? normalized : null;
}

const ctx: SourceContext = {
  push: (item) => {
    void pushSignalAndFlush(item);
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
  createSoundClassifierSource(ctx, { getTranscriptionLanguage: () => transcriptionLanguage }),
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

// ── 源启停串行化 ──
// dev 的 reconcileDesiredSources 有 sourceReconcilePromise 队列；RN 有三个并发
// 入口（master toggle 的 startAmbient、consent reconcile hook、60s watchdog、
// AppState 前台恢复），源的 start/stop 不可重入（重复 addListener / subs 覆盖
// 泄漏），全部排进同一条 promise 链。
let sourceMutationQueue: Promise<unknown> = Promise.resolve();

function enqueueSourceMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = sourceMutationQueue.then(task, task);
  sourceMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// watchdog / AppState 恢复要用的「期望源集合」+ owner（= dev desiredSourceKeys；
// lifecycle.ownerUserId 在全源启动失败时会是 null，watchdog 重试需要独立记住 owner）。
let desiredSourceKeys = new Set<string>();
let runtimeOwnerUserId: string | null = null;

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

// ── 关闸代际（stop-epoch）──
// 「读闸 → 真正启源」之间隔着 await（AsyncStorage/网络/源变更队列），stopAmbient 可以
// 插进缝里 → 停完又被在途的 reconcile 把源启回来 =「开关显示关、麦克风在采」（隐私
// 红线,2026-07-05 对抗审查 F1）。修法：任何关闸动作让代际 +1；带闸判定的调用方在
// **读闸时**捕获代际、随 reconcile 传入，reconcile 在入口/队列内/收尾三处校验，
// 代际过期整体作废。代际在 writeEnabledFlag(false) 同步段递增（先于一切 await）。
let gateCloseEpoch = 0;
// 任意方向的闸写入序号：isAmbientEnabled 用它丢弃「读盘期间闸被写过」的过时回写
// （复核 F-1——stale 读数会把刚关/刚开的镜像翻回去）。与关闸代际分开：这个双向递增，
// 只管镜像回写；gateCloseEpoch 只在关闸递增，管 reconcile 作废（隐私方向）。
let gateWriteSeq = 0;

/** 读闸时捕获，配对传给 reconcileEnabledSources({ gateEpoch })。 */
export function currentGateEpoch(): number {
  return gateCloseEpoch;
}

/** 改本机闸的唯一入口：先更新内存镜像（UI/hook 同步可见，缩小 stale 读窗），再落
 *  AsyncStorage。关闸同时递增代际，作废所有在途的「闸开」调和。 */
async function writeEnabledFlag(enabled: boolean): Promise<void> {
  gateWriteSeq += 1;
  if (!enabled) gateCloseEpoch += 1;
  setEnabledSnapshot(enabled);
  await AsyncStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
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
  const seq = gateWriteSeq;
  const enabled = (await AsyncStorage.getItem(ENABLED_KEY)) === "1";
  if (seq !== gateWriteSeq) {
    // 读盘期间有人写闸：盘上读数已过时，以镜像（writeEnabledFlag 同步更新）为准，
    // 不许 stale 读数把镜像翻回去（复核 F-1）。
    return enabledSnapshot === true;
  }
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
  startPromise = enqueueSourceMutation(() => startAmbientSources(session)).finally(() => {
    if (startPromiseSession?.id === session.id) {
      startPromise = null;
      startPromiseSession = null;
    }
  });
  return startPromise;
}

async function startAmbientSources(session: AmbientStartSession): Promise<string[]> {
  await writeEnabledFlag(true);
  if (!lifecycle.isCurrentStart(session)) {
    // 一个 stop 抢在 writeEnabledFlag 的 await 窗口里插了进来（本次 start 已作废）。
    // 回滚 flag，否则开关会显示"开着"但没有源在跑（旧竞态：早退残留 flag=true）。
    await writeEnabledFlag(false);
    return [];
  }
  desiredSourceKeys = new Set(sources.map((s) => s.key));
  runtimeOwnerUserId = session.userId;
  startIngestLoop(session.userId);
  startRuntimeTimers();
  bindAmbientAppStateLifecycle();
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
  probeSet("ambient.sources", result === "started" ? started.join(",") || "none" : "none"); // __HEAT_PROBE__
  if (result !== "started") {
    await writeEnabledFlag(false);
    desiredSourceKeys = new Set();
    runtimeOwnerUserId = null;
    stopRuntimeTimers("start-failed");
    stopIngestLoop();
  }
  return result === "started" ? started : [];
}

export async function stopAmbient(): Promise<void> {
  await writeEnabledFlag(false);
  lifecycle.stop();
  startPromise = null;
  startPromiseSession = null;
  desiredSourceKeys = new Set();
  runtimeOwnerUserId = null;
  stopRuntimeTimers("stopAmbient");
  await enqueueSourceMutation(async () => {
    for (const s of sources) {
      await s.stop().catch(() => {});
    }
  });
  stopIngestLoop();
  // 全停后主动广播一次，running 徽章即时消失（此前要等下一次采集事件才刷新）。
  notifyStatus();
}

export function ambientRunning(): boolean {
  return lifecycle.running;
}

/**
 * 登录后恢复：本机此前显式开过才自动续采；启动哪些源跟 server per-source
 * consent（= dev App.tsx:77-133 boot 效应——"Once authorized, which sources
 * start follows the server consent, not 'all of them'"）。consent 拉不到时
 * 宁可不启（隐私不变量优先于可用性）。
 */
export async function resumeAmbientIfEnabled(userId: string): Promise<void> {
  // 代际在读闸**之前**捕获：consent 网络往返长达数百 ms，用户在这个窗口里点关
  // 主开关 → 代际过期 → reconcile 整体作废（此前 stop 之后 resume 仍会把源启回来）。
  const gateEpoch = currentGateEpoch();
  if (!(await isAmbientEnabled())) return;
  let consent: { keys: string[]; generationLanguage: string | null };
  try {
    consent = await fetchServerAmbientConsent();
  } catch (err) {
    console.warn("[ambient] consent fetch failed; skipping auto-start", err);
    return;
  }
  setAmbientTranscriptionLanguage(consent.generationLanguage);
  if (consent.keys.length === 0) return; // server 端全关：不启动（本机闸保留，等 consent 恢复）
  await reconcileEnabledSources(userId, consent.keys, { interactivePermissions: false, gateEpoch });
  await flushSignals();
}

/** GET /settings → 已开 consent 的源键 + 生成语言（dev App.tsx 的 enabledKey 数据源）。 */
async function fetchServerAmbientConsent(): Promise<{
  keys: string[];
  generationLanguage: string | null;
}> {
  const res = await proxyFetch("/settings");
  if (!res.ok) throw new Error(`/settings ${res.status}`);
  const data = (await res.json()) as {
    ambientSources?: Record<string, { enabled?: boolean } | null>;
    generationLanguage?: string | null;
  };
  return {
    keys: AMBIENT_SOURCE_KEYS.filter((key) => data.ambientSources?.[key]?.enabled === true),
    generationLanguage: data.generationLanguage ?? null,
  };
}

// ── per-source reconcile + 遥测快照（settings Permissions & sources 面板用）──

interface ReconcileOptions {
  interactivePermissions?: boolean;
  /** 必传：调用方**读闸时**捕获的 currentGateEpoch()。之后任何关闸动作都会使其过期，
   *  reconcile 据此整体作废本次调和（防「读闸后闸被关、调和仍启源」复活竞态）。
   *  设为必传是为了让未来新增调用方无法静默绕过保护（复核 F-4）。 */
  gateEpoch: number;
}

/**
 * 把"正在跑的源集合"调和到 desiredKeys（consent 真集）。web AmbientRuntime
 * .reconcileEnabledSources 的 RN 对应物：desired&&未跑→启，未 desired&&在跑→停，
 * desired&&在跑→refresh() 自愈（= dev runReconcileDesiredSources 的第三分支，
 * watchdog 靠它把 stale/failed 的 sound-classifier 复活）。
 * ≥1 desired 时确保 ingest loop + 定时器在跑；desired 为空（显式全关）才关 loop。
 * **本函数绝不读写本机主闸**（2026-07-05 语义拍板：主闸只归主开关
 * useAmbientToggle/startAmbient/stopAmbient 与 sign-out 所有；settings 源面板
 * 是纯权限管理。采集运行 ⇔ 主闸开 && consent 有源——调用方负责主闸判定：
 * resumeAmbientIfEnabled/consent-reconcile hook 都先查闸再给 keys）。
 * 源启动失败**不**影响闸，留给 watchdog 每 60s 重试（dev watchdog 语义）。
 * 与 master 开关（startAmbient）共享同一 sources 数组，按 isStarted() 收口真相。
 */
export async function reconcileEnabledSources(
  userId: string,
  keys: string[],
  opts: ReconcileOptions,
): Promise<void> {
  // 关闸代际校验①（入口）：调用方读闸之后、走到这里之前闸被关上 → 整体作废，
  // 连 owner/loop/timers 都不碰（stopAmbient 已清场，不能再填回去）。
  const epochValid = () => opts.gateEpoch === gateCloseEpoch;
  if (!epochValid()) return;
  const desired = new Set(keys);
  desiredSourceKeys = new Set(keys);
  if (desired.size > 0) {
    runtimeOwnerUserId = userId;
    startIngestLoop(userId);
    startRuntimeTimers();
    bindAmbientAppStateLifecycle();
  }
  await enqueueSourceMutation(async () => {
    // 校验②（队列内）：排队期间 stopAmbient 插了队 → 本次启停作废（stop-all 已经
    // 或即将在同一队列执行，胜者必须是 stop）。
    if (!epochValid()) return;
    for (const s of sources) {
      // 校验②'（逐源）：关闸落在循环中途时，剩余源（麦克风在启动序第 3 位）不再
      // 启动，交给紧随其后的 stop-all 收尾（复核 F-2，与主路径 per-iteration
      // isCurrentStart 对称）。
      if (!epochValid()) return;
      const shouldRun = desired.has(s.key);
      if (shouldRun && !s.isStarted()) {
        try {
          ctx.onEvent(s.key, "starting");
          // 8s 超时与主路径 startSourceForSession 对称：裸 await 挂死会卡住整条
          // 源变更队列，排在后面的 stop-all 永不执行 = 关不掉的麦克风（复核 F-3）。
          await withTimeout(
            s.start({ interactivePermissions: opts.interactivePermissions ?? true }),
            SOURCE_START_TIMEOUT_MS,
            s.key,
          );
          clearSourceError(s.key);
          ctx.onEvent(s.key, "started");
        } catch (err) {
          // 单源失败（权限拒绝/超时）不影响其他源，错误进遥测让面板显示。
          recordSourceError(s.key, describeError(err));
        }
      } else if (!shouldRun && s.isStarted()) {
        await s.stop().catch(() => {});
      } else if (shouldRun && s.isStarted() && typeof s.refresh === "function") {
        // 在跑的源做健康检查/自愈（dev reconcile 的 refresh 分支）。同样包超时——
        // refresh 内也有原生 await，挂死后果与 F-3 相同（队列堵死）。
        try {
          await withTimeout(s.refresh(), SOURCE_START_TIMEOUT_MS, s.key);
          clearSourceError(s.key);
        } catch (err) {
          recordSourceError(s.key, describeError(err));
        }
      }
    }
  });
  // 校验③（收尾）：源操作期间闸被关 → 不写 lifecycle/遥测（stop 之后的收尾会把
  // running=true 的幽灵态写回，害下一次主开关 ON 被 runningFor 短路空转——审查 F2）。
  if (!epochValid()) return;
  const startedKeys = sources.filter((s) => s.isStarted()).map((s) => s.key);
  probeSet("ambient.sources", startedKeys.join(",") || "none"); // __HEAT_PROBE__
  const running = startedKeys.length > 0;
  // 收口 lifecycle 视图，ambientRunning()/startedSourceKeys 保持真相。
  lifecycle.running = running;
  lifecycle.ownerUserId = running ? userId : null;
  lifecycle.startedSourceKeys = startedKeys;
  if (desired.size === 0) {
    // 显式全关（consent 清空 / 主闸关）：停 loop + 定时器。不碰主闸（见函数注释）。
    runtimeOwnerUserId = null;
    stopRuntimeTimers("reconcile-empty");
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

// ── 定时器：60s watchdog + 15min context snapshot + 15min scheduled summary ──
// （dev AmbientRuntime 构造时起、shutdown 停；RN 随「有 desired 源」起停。）

let sourceWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let timelineSummaryTimer: ReturnType<typeof setInterval> | null = null;
let contextSnapshotTimer: ReturnType<typeof setInterval> | null = null;
let timelineSummaryInFlight = false;
let contextSnapshotInFlight = false;

function startRuntimeTimers(): void {
  if (!sourceWatchdogTimer) {
    sourceWatchdogTimer = setInterval(() => {
      void runSourceWatchdog();
    }, SOURCE_WATCHDOG_INTERVAL_MS);
    console.info(`${POWER_LOG_PREFIX} source watchdog started`, {
      intervalMs: SOURCE_WATCHDOG_INTERVAL_MS,
    });
  }
  // 方案 A（2026-07-01，dev index.ts:167-171 同款）：手机不再做本地聚合 / LLM
  // summary（下沉后端 memory 架构）。停掉 timeline summary（本地 LLM）+ context
  // snapshot（15min 聚合）两个定时器——各 source 信号由 ctx.push 直接上报。
  // 函数保留，恢复时取消注释即可。
  // if (!timelineSummaryTimer) {
  //   timelineSummaryTimer = setInterval(() => {
  //     void runScheduledTimelineSummary();
  //   }, TIMELINE_SUMMARY_INTERVAL_MS);
  // }
  // if (!contextSnapshotTimer) {
  //   contextSnapshotTimer = setInterval(() => {
  //     void runScheduledContextSnapshot();
  //   }, CONTEXT_SNAPSHOT_INTERVAL_MS);
  // }
  probeSet("ambient.timers", "on"); // __HEAT_PROBE__
}

function stopRuntimeTimers(reason: string): void {
  let stopped = 0;
  if (sourceWatchdogTimer) {
    clearInterval(sourceWatchdogTimer);
    sourceWatchdogTimer = null;
    stopped += 1;
  }
  if (timelineSummaryTimer) {
    clearInterval(timelineSummaryTimer);
    timelineSummaryTimer = null;
    stopped += 1;
  }
  if (contextSnapshotTimer) {
    clearInterval(contextSnapshotTimer);
    contextSnapshotTimer = null;
    stopped += 1;
  }
  if (stopped > 0) {
    console.info(`${POWER_LOG_PREFIX} runtime timers stopped`, { reason, stopped });
    probeSet("ambient.timers", `off:${reason}`); // __HEAT_PROBE__
  }
}

/** 60s 自愈（dev startSourceWatchdog → refreshActiveSources）：按 desired 集
 *  重新调和——挂掉的源重启、在跑的源 refresh() 健康检查。 */
async function runSourceWatchdog(): Promise<void> {
  const gateEpoch = currentGateEpoch(); // tick 开始时捕获,stop 插队即作废本轮自愈
  const owner = runtimeOwnerUserId;
  if (!owner || desiredSourceKeys.size === 0) return;
  probeCount("ambient.watchdogTick"); // __HEAT_PROBE__
  await reconcileEnabledSources(owner, Array.from(desiredSourceKeys), {
    interactivePermissions: false,
    gateEpoch,
  });
}

/** 15min context snapshot（dev runScheduledContextSnapshot → refreshContextSnapshot）：
 *  近 15min 各源 raw 聚合成 context_snapshot candidate window → 上传 outbox。
 *  方案 A 后定时器已停（startRuntimeTimers 注释块）、当前无调用方；export 保留
 *  作恢复口（与 runScheduledTimelineSummary 对称）。 */
export async function runScheduledContextSnapshot(): Promise<void> {
  if (contextSnapshotInFlight) return;
  contextSnapshotInFlight = true;
  try {
    const signal = await getAmbientTimelinePipeline().generateContextSnapshot(new Date());
    if (signal) pushSignal(signal);
  } catch (err) {
    setLastIngestError(describeError(err));
    console.warn("[ambient] context snapshot failed:", err);
  } finally {
    contextSnapshotInFlight = false;
  }
}

/**
 * 15min scheduled summary（dev runScheduledTimelineSummary:467-497）：
 * cloud-first 桥（uploads 未锁 & 偏好 cloud_when_unlocked）或端侧桥生成当日
 * 摘要事件；成功后 refreshTimeline 把蒸馏产物送进上传 outbox。锁上后中途
 * 复查（shouldUseCloud / shouldPersistResult），锁下产物不外发。
 */
export async function runScheduledTimelineSummary(nowOverride?: Date): Promise<void> {
  if (timelineSummaryInFlight) return;
  timelineSummaryInFlight = true;
  try {
    const now = nowOverride ?? new Date();
    const localDate = now.toISOString().slice(0, 10);
    const uploadsLockedAtStart = uploadsLockedSnapshot();
    const preference = await loadAmbientSummaryPreference();
    const bridge =
      effectiveAmbientSummaryMode({ uploadsLocked: uploadsLockedAtStart, preference }) === "cloud_llm"
        ? createCloudFirstAmbientSummaryBridge({
          shouldUseCloud: () => !uploadsLockedSnapshot(),
        })
        : createLocalAmbientSummaryBridge();
    const result = await maybeRunScheduledAmbientSummary({
      store: getAmbientTimelineStore(),
      bridge,
      now,
      localDate,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      localUserId: runtimeOwnerUserId ?? "local",
      shouldPersistResult: (summaryResult) =>
        summaryResult.generationMethod !== "cloud_llm" || !uploadsLockedSnapshot(),
    });
    if (result.ran && result.status === "success") {
      await refreshTimeline(localDate);
    }
  } catch (err) {
    console.warn("[ambient] scheduled summary failed:", err);
  } finally {
    timelineSummaryInFlight = false;
  }
}

// ── AppState 前后台钩子（dev lifecycle.ts bindAmbientLifecycle）──
// 前台恢复：reconcile 自愈 + drain；切后台：把已排队的信号最后 drain 一次。
// drain 永远安全（只 flush 已排队事件，绝不自行启源——隐私不变量）。

let appStateBound = false;

function bindAmbientAppStateLifecycle(): void {
  if (appStateBound) return;
  appStateBound = true;
  AppState.addEventListener("change", (state) => {
    const owner = runtimeOwnerUserId;
    if (!owner) {
      console.info(`${POWER_LOG_PREFIX} appStateChange skipped; ambient not running`, { state });
      return;
    }
    if (state === "active") {
      void (async () => {
        // F5(2026-07-06 Mengli 拍板):回前台重拉 server consent + reconcile——远端(web/
        // 另一设备)重开某源授权后,主闸开着则本机自动恢复采集(含麦克风)。resumeAmbientIfEnabled
        // 内含查闸(gate 关则 no-op)+ 拉 /settings consent + reconcile;reconcile 会把
        // desiredSourceKeys 更新成新 consent 集供 60s watchdog 续用,并顺带做健康自愈(挂掉的源
        // 重启)——取代原来只 reconcile 本地 desired 的 runSourceWatchdog(检测不到远端 consent 变化)。
        await resumeAmbientIfEnabled(owner);
        await flushSignals();
      })();
      return;
    }
    void flushSignals();
  });
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
