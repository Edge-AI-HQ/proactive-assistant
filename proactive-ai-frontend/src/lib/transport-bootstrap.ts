/**
 * Web 端的 transport 组装点（composition root）—— @pin-ai/core 的平台注入。
 *
 * core 不认识 supabase / Capacitor / import.meta.env；auth、baseUrl、平台
 * headers 在这里组装后经 configureTransport 注入。模块加载即配置（side
 * effect）：`@/lib/api` shim re-export 本文件，所以任何旧路径的 import 都会
 * 先完成注入——与原 api.ts「自带 auth」的语义一致，测试的 vi.mock("./supabase")
 * / vi.mock("./platform") 模块拦截也照常生效。
 * 设计 SSOT：research/2026-06-10-frontend-layering.mdx §4.2-§4.3。
 */
import { configureTransport } from "@pin-ai/core";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthHeaders } from "./dev-auth";
import { PIN_API_BASE, pinApiRequestHeaders } from "./platform";
import { supabase } from "./supabase";

export function profileClientHintHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof navigator !== "undefined") {
    const locale = navigator.languages?.[0] || navigator.language;
    if (locale && locale.trim()) {
      headers["X-Pin-Client-Locale"] = locale.trim();
    }
  }

  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone && timezone.trim()) {
      headers["X-Pin-Client-Timezone"] = timezone.trim();
    }
  } catch {
    // Browser/runtime did not expose Intl timezone; server keeps its value.
  }

  return headers;
}

async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function authHeaders(): Promise<Record<string, string>> {
  if (isPinLocalDevAuthEnabled()) return pinLocalDevAuthHeaders();
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 *
 * Concurrent callers (e.g. multiple panels firing /api/* on AppShell
 * mount and all hitting 401 simultaneously) share one in-flight refresh
 * via the module-level promise cache. Without this, parallel
 * `refreshSession()` calls race against gotrue's single-use refresh
 * token semantics: the first call consumes the refresh token, the rest
 * get "Invalid Refresh Token" and supabase fires SIGNED_OUT — kicking
 * the user back to LoginPage right after login.
 */
let refreshPromise: Promise<string | null> | null = null;

async function refreshAndGetToken(): Promise<string | null> {
  if (isPinLocalDevAuthEnabled()) return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session) return null;
      return data.session.access_token;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

configureTransport({
  baseUrl: PIN_API_BASE,
  getAuthHeaders: authHeaders,
  refreshAuth: refreshAndGetToken,
  // ngrok-skip-browser-warning 等平台 headers（web 同源时为空对象）。
  defaultHeaders: pinApiRequestHeaders(),
  clientHintHeaders: profileClientHintHeaders,
});
