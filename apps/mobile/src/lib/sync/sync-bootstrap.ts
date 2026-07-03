/**
 * 同步引擎平台壳（RN）。调度逻辑在 @pin-ai/core 的 createSyncScheduler
 * （与 web/Electron 共用）；这里只有平台职责：expo-sqlite driver 注入、
 * per-user 库名、登录后生命周期。导出在未启动时安全 no-op。
 */
import {
  createSyncScheduler,
  type ConversationHistoryPage,
  type SyncScheduler,
} from "@pin-ai/core";

import { createExpoDatabase } from "./expo-database";

const FALLBACK_INTERVAL_MS = 30 * 60 * 1000;

let startedForUser: string | null = null;
let scheduler: SyncScheduler | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
// 引擎未启动（登录前/登出后）时 enqueueFeedback 的内存暂存：startSync 后
// 重放进 durable outbox——对齐 dev「outbox 已注册即不丢」的语义，不静默丢。
let pendingFeedback: Array<{ body: unknown; dedupeKey?: string }> = [];

export function startSync(userId: string): void {
  if (!userId) return;
  if (startedForUser) {
    if (startedForUser !== userId) {
      console.warn("[sync] user changed in-process; sync stays on", startedForUser);
    }
    return;
  }
  startedForUser = userId;
  const db = createExpoDatabase(`pinai_sync_${userId.replace(/[^A-Za-z0-9]/g, "_")}`);
  scheduler = createSyncScheduler({
    db,
    log: (msg, extra) => console.log(`[sync] ${msg}`, JSON.stringify(extra ?? {})),
  });
  // 启动前暂存的 feedback 先入 durable outbox（enqueue 走引擎串行队列，
  // 排在下面首轮 pass 的 drain 之前），再跑首轮 pass 顺带投递。
  const queued = pendingFeedback;
  pendingFeedback = [];
  for (const item of queued) void scheduler.enqueueFeedback(item.body, item.dedupeKey);
  void scheduler.runFullPass();
  fallbackTimer = setInterval(() => void scheduler?.runFullPass(), FALLBACK_INTERVAL_MS);
}

/** signOut 收口（sign-out.ts 调用）：停兜底轮询、复位启动 latch——同一 JS
 *  进程里下个账号登录能重新 startSync（web 版靠 full reload，RN 无 reload）。
 *  内存暂存的 feedback 一并丢弃：不能把 A 的反馈重放进 B 的库。 */
export function stopSync(): void {
  if (fallbackTimer !== null) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  scheduler = null;
  startedForUser = null;
  pendingFeedback = [];
}

export function notifyThreadActivity(threadId: string): void {
  scheduler?.notifyThreadActivity(threadId);
}

export async function readLocalHistory(
  threadId: string,
  limit = 200,
): Promise<ConversationHistoryPage | null> {
  return scheduler ? scheduler.readLocalHistory(threadId, limit) : null;
}

export async function enqueueFeedback(body: unknown, dedupeKey?: string): Promise<boolean> {
  if (scheduler) return scheduler.enqueueFeedback(body, dedupeKey);
  // 引擎未启动：落内存队列，startSync 后重放（dedupe 由 outbox 的
  // dedupeKey 兜底），不静默丢弃。
  pendingFeedback.push({ body, dedupeKey });
  return true;
}
