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
  void scheduler.runFullPass();
  setInterval(() => void scheduler?.runFullPass(), FALLBACK_INTERVAL_MS);
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
  return scheduler ? scheduler.enqueueFeedback(body, dedupeKey) : false;
}
