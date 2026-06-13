/**
 * /feedback POST 失败时的离线 outbox 注入点（composition root 注册，与
 * auth-cleanup 的 registerSignOutCleanup 同模式）。
 *
 * proactive-ai-frontend 在 main.tsx 注册 lib/sync 的 enqueueFeedback
 * （native/Electron 本地 SQLite outbox，重连后重放）；apps/web 暂无本地
 * 同步引擎，不注册 → 失败仅记 log（与旧实现 outbox 未启动时的行为一致）。
 */
export type FeedbackOutbox = (
  body: Record<string, unknown>,
  dedupeKey?: string,
) => void | Promise<unknown>;

let outbox: FeedbackOutbox | null = null;

export function registerFeedbackOutbox(fn: FeedbackOutbox): void {
  outbox = fn;
}

/** useCardActions 的 catch 路径调用——有注册走 outbox，没注册记 log 丢弃。 */
export function enqueueFeedback(
  body: Record<string, unknown>,
  dedupeKey?: string,
): void {
  if (outbox) {
    void outbox(body, dedupeKey);
    return;
  }
  console.warn("[feedback] POST failed and no offline outbox registered — dropped", dedupeKey ?? "");
}
