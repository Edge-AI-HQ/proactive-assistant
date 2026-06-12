/**
 * Composio connector API（最小面：状态 / 连接列表 / 发起连接）——从 web
 * 的 useComposio 下沉（RN Connect 视图共用协议）。catalog 浏览、自定义
 * MCP、disconnect 等扩展面仍在 web hook，需要时再下沉。
 */
import { proxyFetch, proxyPost } from "../transport/http";

export interface ComposioStatus {
  configured: boolean;
}

export interface ComposioConnection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  /** Backend-resolved display label (email / username / etc.). */
  label: string | null;
  userInfo: Record<string, unknown> | null;
}

export async function fetchComposioStatus(signal?: AbortSignal): Promise<ComposioStatus> {
  const res = await proxyFetch("/composio/status", { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ComposioStatus;
}

export async function fetchComposioConnections(
  signal?: AbortSignal,
): Promise<ComposioConnection[]> {
  const res = await proxyFetch("/composio/connections", { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { connections?: ComposioConnection[] };
  return data.connections ?? [];
}

/** 发起 toolkit 连接。已 ACTIVE（无需 OAuth）→ redirectUrl 为空；
 *  否则返回 OAuth 跳转 URL（调用方负责打开并在回归后刷新连接列表）。 */
export async function connectComposioToolkit(
  toolkit: string,
): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> {
  const res = await proxyPost("/composio/connect", { toolkit });
  const data = (await res.json()) as {
    status?: string;
    redirectUrl?: string;
    detail?: string;
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const error =
      data.detail
      ?? (typeof data.error === "string" ? data.error : data.error?.message)
      ?? `Connect failed (${res.status})`;
    return { ok: false, error };
  }
  if (data.status === "ACTIVE") return { ok: true };
  if (data.redirectUrl) return { ok: true, redirectUrl: data.redirectUrl };
  return { ok: false, error: "No redirect URL returned" };
}
