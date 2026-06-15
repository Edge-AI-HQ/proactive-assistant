/**
 * 本地同步引擎(per-user 本地 DB:frontend native / apps-web 无 / RN expo-sqlite)的
 * 注入点 —— 各 app composition root 注册。平台无关。
 *
 * 注册了走本地 history / 通知活动;没注册 → notify no-op、本地 history 恒 null
 * (落纯网络路径)。
 */
import type { ConversationHistoryPage } from "../api/conversation";

export interface LocalThreadStore {
  notifyThreadActivity: (threadId: string) => void;
  readLocalHistory: (
    threadId: string,
    limit?: number,
  ) => Promise<ConversationHistoryPage | null>;
}

let store: LocalThreadStore | null = null;

export function registerLocalThreadStore(next: LocalThreadStore): void {
  store = next;
}

export function notifyThreadActivity(threadId: string): void {
  store?.notifyThreadActivity(threadId);
}

export async function readLocalHistory(
  threadId: string,
  limit = 200,
): Promise<ConversationHistoryPage | null> {
  return store ? store.readLocalHistory(threadId, limit) : null;
}
