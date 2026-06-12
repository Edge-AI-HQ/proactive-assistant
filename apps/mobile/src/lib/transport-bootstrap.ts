/**
 * @pin-ai/core transport 注入（RN 端）。
 *
 * fetchImpl 用 `expo/fetch`（WinterCG 兼容）：RN 内置 fetch 不支持
 * ReadableStream，整条 SSE 链路（chat stream / resumable cursor）跑不通
 * ——这是分层调研里标记的 RN 硬雷，注入点在这里解决。
 */
import { fetch as expoFetch } from "expo/fetch";
import { configureTransport } from "@pin-ai/core";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthHeaders } from "./dev-auth";
import { ENV } from "./env";
import { supabase } from "./supabase";

async function authHeaders(): Promise<Record<string, string>> {
  // 本地 dev 旁路（web transport-bootstrap 同构）：X-Dev-Auth 替代 Bearer。
  if (isPinLocalDevAuthEnabled()) return pinLocalDevAuthHeaders();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function refreshAuth(): Promise<string | null> {
  if (isPinLocalDevAuthEnabled()) return null;
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

configureTransport({
  baseUrl: ENV.pinApiUrl,
  getAuthHeaders: authHeaders,
  refreshAuth,
  fetchImpl: expoFetch as unknown as typeof fetch,
});
