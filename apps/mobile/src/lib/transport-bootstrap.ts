/**
 * @pin-ai/core transport 注入（RN 端）。
 *
 * fetchImpl 用 `expo/fetch`（WinterCG 兼容）：RN 内置 fetch 不支持
 * ReadableStream，整条 SSE 链路（chat stream / resumable cursor）跑不通
 * ——这是分层调研里标记的 RN 硬雷，注入点在这里解决。
 *
 * clientHintHeaders / getClientHints / onAuthInvalid / refresh 单飞对齐
 * web 版（packages/ui-web/src/auth/transport-bootstrap.ts）；介质差异：
 * locale 取 iOS SettingsManager（= i18n detectDeviceLanguage 同源）、
 * viewport 取 Dimensions、登出收口走 RN performSignOut（无 reload）。
 */
import { Dimensions, NativeModules, Platform } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { configureTransport, type DeviceClientHints } from "@pin-ai/core";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthHeaders } from "./dev-auth";
import { ENV } from "./env";
import { performSignOut } from "./sign-out";
import { supabase } from "./supabase";

function profileClientHintHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // 设备语言：iOS SettingsManager（i18n detectDeviceLanguage 同源，
  // AppleLanguages 首项是 BCP-47 tag），兜底 Hermes Intl 的 resolvedOptions。
  const settingsManager = (NativeModules as {
    SettingsManager?: { settings?: { AppleLanguages?: string[]; AppleLocale?: string } };
  }).SettingsManager;
  let locale =
    settingsManager?.settings?.AppleLanguages?.[0] ?? settingsManager?.settings?.AppleLocale;
  if (!locale) {
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      // Runtime did not expose Intl locale; server keeps its value.
    }
  }
  if (locale && locale.trim()) {
    headers["X-Pin-Client-Locale"] = locale.trim();
  }

  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone && timezone.trim()) {
      headers["X-Pin-Client-Timezone"] = timezone.trim();
    }
  } catch {
    // Runtime did not expose Intl timezone; server keeps its value.
  }

  // 时区头的采信分级靠它：服务端只让手机(ios/android)完整跟随+retime,
  // web 只能 seed 未确立的时区。RN 真机 Platform.OS = "ios"，与 dev native
  // 的 Capacitor.getPlatform() 同值域（RN-web 预览形态 = "web"）。
  headers["X-Pin-Client-Platform"] = Platform.OS;

  return headers;
}

/**
 * Display device hints for the remote browser — browser_tool sizes the
 * Browserbase session + picks a mobile stealth UA off these. snake_case
 * matches the backend ClientHintsBody; values clamped to its 200–4096 px
 * bounds（web 版同款）。RN 只跑手机，device_kind 恒 "mobile"。
 */
function probeClientHints(): DeviceClientHints {
  const clamp = (v: number) => Math.min(4096, Math.max(200, Math.round(v)));
  const { width, height } = Dimensions.get("window");
  return {
    viewport_width: clamp(width || 390),
    viewport_height: clamp(height || 844),
    device_kind: "mobile",
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  // 本地 dev 旁路（web transport-bootstrap 同构）：X-Dev-Auth 替代 Bearer。
  if (isPinLocalDevAuthEnabled()) return pinLocalDevAuthHeaders();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 *
 * Concurrent callers (e.g. multiple panels firing /api/* on shell mount
 * and all hitting 401 simultaneously) share one in-flight refresh via the
 * module-level promise cache. Without this, parallel `refreshSession()`
 * calls race against gotrue's single-use refresh token semantics: the
 * first call consumes the refresh token, the rest get "Invalid Refresh
 * Token" and supabase fires SIGNED_OUT — kicking the user back to the
 * login screen right after login.
 */
let refreshPromise: Promise<string | null> | null = null;

async function refreshAuth(): Promise<string | null> {
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
 * localDevAuth 下 X-Dev-Auth 永不该 401，万一触发也不能清掉 dev session，
 * 直接 no-op。
 */
function handleAuthInvalid(): void {
  if (isPinLocalDevAuthEnabled()) return;
  console.warn("[auth] session unrecoverable (401 after refresh) — signing out");
  void performSignOut();
}

configureTransport({
  baseUrl: ENV.pinApiUrl,
  getAuthHeaders: authHeaders,
  refreshAuth,
  onAuthInvalid: handleAuthInvalid,
  clientHintHeaders: profileClientHintHeaders,
  getClientHints: probeClientHints,
  fetchImpl: expoFetch as unknown as typeof fetch,
});
