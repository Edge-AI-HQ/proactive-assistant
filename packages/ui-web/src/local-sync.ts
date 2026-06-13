/**
 * 本地同步引擎（native/Electron per-user SQLite）的注入点 —— composition
 * root 注册，与 auth-cleanup / feedback-outbox 同模式。
 *
 * proactive-ai-frontend 在 main.tsx 注册 lib/sync/sync-bootstrap 的实现；
 * apps/web 暂无本地同步引擎，不注册 → notify no-op、本地 history 恒 null
 * （ConversationView / useCardExecutionRun 落到纯网络路径，行为与引擎未
 * 启动时一致）。
 */
import type { ConversationHistoryPage } from "@pin-ai/core";

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
