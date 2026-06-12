/**
 * Supabase client（RN）：AsyncStorage 持久化 + PKCE（OAuth 回调走
 * ASWebAuthenticationSession，code 在 app 内换 session，token 不进 URL）。
 * detectSessionInUrl 关闭——RN 没有 SPA 的 URL hash 语义。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { createClient } from "@supabase/supabase-js";

import { ENV } from "./env";

export const supabase = createClient(ENV.supabaseUrl, ENV.supabasePublishableKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});

// supabase-js 官方 RN 惯例：前台时跑 token auto-refresh，后台停（省电 +
// 避免后台网络失败把 session 标坏）。
AppState.addEventListener("change", (state) => {
  if (state === "active") void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});
