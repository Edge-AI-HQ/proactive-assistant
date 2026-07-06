import { proxyFetch, proxyPost } from "./http";

/**
 * SSE stream（POST）。手工解析 fetch ReadableStream —— 不用 EventSource，
 * 因为要带请求体与 auth headers。RN 端依赖注入的 expo/fetch 提供流式 body。
 * Returns an async iterator of parsed JSON events.
 */
export async function* proxySSE<T = unknown>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const res = await proxyPost(path, body, signal);
  if (!res.ok) throw new Error(`Proxy SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as T;
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    // 早退（消费者 break / for-await 的 .return()）时仅 releaseLock 不关底层 fetch
    // 流，连接会悬挂到服务端超时。cancel() 主动取消流 → 立刻关连接（省电/防泄漏），
    // 正常结束时 no-op、abort 后可能 reject 故 catch。注入的 fetch（RN expo/fetch）
    // reader 万一无 cancel 则退回 releaseLock，零回归。
    if (typeof reader.cancel === "function") {
      await reader.cancel().catch(() => {});
    } else {
      reader.releaseLock();
    }
  }
}

/** GET-based SSE generator — sibling of `proxySSE` (which is POST-only). Used
 * by the resumable conversation stream. Yields `{ event, lastEventId }`: the
 * `lastEventId` is the Redis Stream entry id from the preceding `id:` line (the
 * resume cursor) — the caller stores it and echoes it back as `?lastEventId=`
 * on reconnect so the server replays exactly the frames missed while gone. */
export async function* proxyGetSSE<T = unknown>(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ event: T; lastEventId: string | null }> {
  const res = await proxyFetch(path, { signal });
  if (!res.ok) throw new Error(`Proxy GET SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The current resume cursor — tracked across chunks so each event is tagged
  // with the `id:` that preceded it (an id line and its data line can split
  // across reads).
  let lastEventId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // blank / `: ping` keepalive
        if (trimmed.startsWith("id:")) {
          lastEventId = trimmed.slice(3).trim();
          continue;
        }
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield { event: JSON.parse(data) as T, lastEventId };
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    // 早退（消费者 break / for-await 的 .return()）时仅 releaseLock 不关底层 fetch
    // 流，连接会悬挂到服务端超时。cancel() 主动取消流 → 立刻关连接（省电/防泄漏），
    // 正常结束时 no-op、abort 后可能 reject 故 catch。注入的 fetch（RN expo/fetch）
    // reader 万一无 cancel 则退回 releaseLock，零回归。
    if (typeof reader.cancel === "function") {
      await reader.cancel().catch(() => {});
    } else {
      reader.releaseLock();
    }
  }
}
