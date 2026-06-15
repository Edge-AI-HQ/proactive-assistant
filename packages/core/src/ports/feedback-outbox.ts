/**
 * /feedback POST 失败时的离线 outbox 注入点（各 app composition root 注册）。平台无关。
 *
 * 有本地同步引擎的 app(frontend native / RN expo-sqlite outbox)注册重放实现;
 * 无本地引擎的 app(apps/web)不注册 → 失败仅记 log 丢弃。
 */
export type FeedbackOutbox = (
  body: Record<string, unknown>,
  dedupeKey?: string,
) => void | Promise<unknown>;

let outbox: FeedbackOutbox | null = null;

export function registerFeedbackOutbox(fn: FeedbackOutbox): void {
  outbox = fn;
}

/** card action catch 路径调用——有注册走 outbox,没注册记 log 丢弃。 */
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
