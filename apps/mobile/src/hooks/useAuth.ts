/**
 * Auth hook（RN）：Supabase Google OAuth via PKCE + ASWebAuthenticationSession
 * （expo-web-browser 的 openAuthSessionAsync——系统级登录面板，回调 scheme
 * 自动接收，无需手挂 deep link listener；比 Capacitor 的 appUrlOpen 链路
 * 更原生）。verifier 在本端 AsyncStorage，发起与 code exchange 同端完成。
 */
import { useCallback, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { runSignOutCleanups } from "@pin-ai/core";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthUser } from "../lib/dev-auth";
import { supabase } from "../lib/supabase";

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ loading: true, session: null, user: null });

  useEffect(() => {
    // 本地 dev 旁路（web useAuth 同构）：跳过 Supabase，直接合成用户。
    if (isPinLocalDevAuthEnabled()) {
      setState({ loading: false, session: null, user: pinLocalDevAuthUser() });
      return;
    }
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ loading: false, session, user: session?.user ?? null });
    });
    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // scheme://auth/callback（app.json 的 scheme = 本环境 bundle id，与
    // Capacitor 时代同一 Supabase Redirect URLs 条目，零新增配置）。
    const redirectTo = Linking.createURL("auth/callback");
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw error;
    if (!data?.url) return;

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== "success") return; // 用户取消/关闭面板
    const params = new URL(result.url).searchParams;
    const oauthError = params.get("error");
    if (oauthError) {
      console.error("[auth] OAuth provider error:", params.get("error_description") || oauthError);
      return;
    }
    const code = params.get("code");
    if (!code) {
      console.error("[auth] OAuth callback missing authorization code");
      return;
    }
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) console.error("[auth] code exchange failed:", exchangeError.message);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    // 平台清理(清 device 凭据等)——各 app 经 registerSignOutCleanup 注册;
    // 无注册则 no-op(core/ports/sign-out-cleanup)。
    await runSignOutCleanups();
  }, []);

  return { ...state, signInWithGoogle, signOut };
}
