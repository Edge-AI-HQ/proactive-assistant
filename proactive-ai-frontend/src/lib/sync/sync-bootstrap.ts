/**
 * 同步引擎平台壳（web app：Capacitor iOS + Electron 桌面）。
 *
 * 调度逻辑（全局串行、门铃合并、push-then-pull pass）在 @pin-ai/core 的
 * createSyncScheduler——三端共用；本文件只负责平台职责：
 * - **driver 注入**：isNative → Capacitor 插件；isElectron → node:sqlite
 *   over IPC。**per-user 本地库** `pinai_sync_<uid>`（业界 per-account
 *   database 惯例）——换账号登录时数据/游标/outbox 天然隔离。进程内不
 *   换号（signOut 走 full reload），uid 变化只 warn。
 * - **生命周期**：登录后启动首轮 pass + 30 分钟兜底轮询（门铃承担实时性）。
 * - **平台钩子**：Electron 的新卡系统通知。
 *
 * 各导出在引擎未启动（web 浏览器、未登录）时是安全 no-op——调用方无需
 * gate，行为不劣于切换前。
 */
import {
  createSyncScheduler,
  type CardSearchHit,
  type ConversationHistoryPage,
  type MessageSearchHit,
  type SyncScheduler,
} from "@pin-ai/core";
import { isElectron, isNative } from "../platform";
import { createCapacitorDatabase } from "./capacitor-database";
import { createElectronDatabase } from "./electron-database";
import { notifyNewCards } from "./desktop-notifications";

const FALLBACK_INTERVAL_MS = 30 * 60 * 1000;

let startedForUser: string | null = null;
let scheduler: SyncScheduler | null = null;

export function startShadowSync(userId: string): void {
  if ((!isNative && !isElectron) || !userId) return;
  if (startedForUser) {
    if (startedForUser !== userId) {
      // signOut 走 full reload，进程内换号不应发生——真发生宁可不同步，
      // 也不能把 B 的数据写进 A 的库。
      console.warn("[sync] user changed without reload; sync stays on", startedForUser);
    }
    return;
  }
  startedForUser = userId;
  const dbName = `pinai_sync_${userId.replace(/[^A-Za-z0-9]/g, "_")}`;
  const db = isNative ? createCapacitorDatabase(dbName) : createElectronDatabase(dbName);
  scheduler = createSyncScheduler({
    db,
    log: (msg, extra) => console.log(`[sync] ${msg}`, JSON.stringify(extra ?? {})),
    onNewCards: (database, ids) => void notifyNewCards(database, ids),
  });
  void scheduler.runFullPass();
  setInterval(() => void scheduler?.runFullPass(), FALLBACK_INTERVAL_MS);
}

/** 门铃入口：turn finalize / thread 打开时调用。 */
export function notifyThreadActivity(threadId: string): void {
  scheduler?.notifyThreadActivity(threadId);
}

/** B3b 读路径：本地同步库的 history page。 */
export async function readLocalHistory(
  threadId: string,
  limit = 200,
): Promise<ConversationHistoryPage | null> {
  return scheduler ? scheduler.readLocalHistory(threadId, limit) : null;
}

/** 离线可靠投递入口（Sync-C）：feedback 失败时入队，pass/门铃驱动重放。 */
export async function enqueueFeedback(body: unknown, dedupeKey?: string): Promise<boolean> {
  return scheduler ? scheduler.enqueueFeedback(body, dedupeKey) : false;
}

/** 本地全文搜索（messages + cards FTS）。 */
export async function searchLocal(
  query: string,
): Promise<{ messages: MessageSearchHit[]; cards: CardSearchHit[] }> {
  return scheduler ? scheduler.searchLocal(query) : { messages: [], cards: [] };
}
