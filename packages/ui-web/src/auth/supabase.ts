import { createClient } from "@supabase/supabase-js";
import { isElectron, isNative } from "./platform";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabasePublishableKey = import.meta.env
  .VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY environment variables",
  );
}

/**
 * OAuth web 回调失败（用户拒绝授权 / 非 test user / provider 报错）时，
 * Supabase implicit flow 把错误放进回调 URL —— hash fragment 优先（implicit
 * 约定），也兼容 query。supabase-js 的 detectSessionInUrl 初始化时会异步把
 * URL 清空，所以这里在 createClient 之前同步抓一次存成模块常量，否则用户被
 * 打回登录页却看不到任何原因（典型：改了 Google OAuth test users 后自己的
 * 账号被拒）。native/Electron 走 PKCE deep-link，error 由 useAuth 的
 * exchangeOauthCallback 处理，不经这里。
 */
export function parseOAuthError(hash: string, search: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, ""));
  const fromQuery = new URLSearchParams(search.replace(/^\?/, ""));
  return (
    fromHash.get("error_description") ??
    fromQuery.get("error_description") ??
    fromHash.get("error") ??
    fromQuery.get("error") ??
    null
  );
}

function captureInitialOAuthError(): string | null {
  if (typeof window === "undefined") return null;
  const message = parseOAuthError(window.location.hash, window.location.search);
  // 抓到就把 error 从 URL 抹掉（成功路径没有 error 参数，不受影响），避免刷新
  // 后又弹、或 error 留在地址栏。
  if (message && window.history?.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return message;
}

/** OAuth web 回调错误，整页加载时抓一次。null = 无错误（正常进入）。 */
export const initialOAuthError = captureInitialOAuthError();

// Defaults from supabase-js (autoRefreshToken / persistSession /
// detectSessionInUrl all true) cover the SPA flow. Native and the
// Electron desktop shell override to PKCE so the deep-link callback
// carries `?code=` (exchanged in-app via exchangeCodeForSession) and
// tokens never appear in the URL — implicit flow would put
// `#access_token` in the callback, which the deep-link handler can't
// consume (it never reaches detectSessionInUrl in another window).
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  ...((isNative || isElectron) && { auth: { flowType: "pkce" as const } }),
});
