/**
 * web 介质的 transport 组装点（composition root）—— @pin-ai/core 的平台注入。
 *
 * core 不认识 supabase / import.meta.env；auth、baseUrl、平台 headers 在
 * 这里组装后经 configureTransport 注入。模块加载即配置（side effect）：
 * app 入口 import 本模块（直接或经 barrel），任何路径的 import 都会先完成
 * 注入。设计 SSOT：research/2026-06-10-frontend-layering.mdx §4.2-§4.3。
 */
import { configureTransport, type DeviceClientHints } from "@pin-ai/core";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthHeaders } from "./dev-auth";
import { PIN_API_BASE } from "./platform";
import { performSignOut } from "./sign-out";
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

  // 时区头的采信分级靠它：服务端只让手机(ios/android)完整跟随+retime,
  // web/Electron 恒 "web"，只能 seed 未确立的时区——防止出差时家里
  // 桌面端把时区翻回去(_sync_device_timezone 的平台分级)。
  headers["X-Pin-Client-Platform"] = "web";

  return headers;
}

/**
 * Display device hints for the remote browser — browser_tool sizes the
 * Browserbase session + picks a mobile/tablet/desktop stealth UA off these.
 * snake_case matches the backend ClientHintsBody; values clamped to its
 * 200–4096 px bounds so a tiny window can't 422 the send. Coarse pointer +
 * width disambiguates a phone from a narrow desktop window (Tailwind md/lg).
 */
function probeClientHints(): DeviceClientHints {
  if (typeof window === "undefined") {
    return { viewport_width: 1280, viewport_height: 800, device_kind: "desktop" };
  }
  const clamp = (v: number) => Math.min(4096, Math.max(200, Math.round(v)));
  const w = clamp(window.innerWidth || 1280);
  const h = clamp(window.innerHeight || 800);
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  let device_kind: DeviceClientHints["device_kind"];
  if (w < 768) device_kind = "mobile";
  else if (w < 1024 && coarse) device_kind = "tablet";
  else device_kind = "desktop";
  return { viewport_width: w, viewport_height: h, device_kind };
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

/**
 * 传输层判定 session 不可恢复时的全局收口（HTTP 层 401 + refresh 失败触发）：
 * 清本地态回登录页。performSignOut 自身幂等，并发 401 多次触发也只清一次。
 * localDevAuth 下 X-Dev-Auth 永不该 401，万一触发也不能 reload 掉 dev session
 * （且会 reload 循环），直接 no-op。
 */
function handleAuthInvalid(): void {
  if (isPinLocalDevAuthEnabled()) return;
  console.warn("[auth] session unrecoverable (401 after refresh) — signing out");
  void performSignOut();
}

configureTransport({
  baseUrl: PIN_API_BASE,
  getAuthHeaders: authHeaders,
  refreshAuth: refreshAndGetToken,
  onAuthInvalid: handleAuthInvalid,
  clientHintHeaders: profileClientHintHeaders,
  getClientHints: probeClientHints,
});
