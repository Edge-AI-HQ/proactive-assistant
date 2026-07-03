/**
 * Auth hook（RN）：Supabase Google OAuth via PKCE + ASWebAuthenticationSession
 * （expo-web-browser 的 openAuthSessionAsync——系统级登录面板，回调 scheme
 * 自动接收，无需手挂 deep link listener；比 Capacitor 的 appUrlOpen 链路
 * 更原生）。verifier 在本端 AsyncStorage，发起与 code exchange 同端完成。
 */
import { useCallback, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthUser } from "../lib/dev-auth";
import { performSignOut } from "../lib/sign-out";
import { supabase } from "../lib/supabase";

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
}

/** 解析 OAuth 回调并换取 session。失败时 throw——调用方（LoginScreen）把它映射到
 *  dev web 同款的登录错误横幅（dev 的 initialOAuthError 抓的正是这三类错误）。 */
async function exchangeOauthCallback(url: string): Promise<void> {
  const params = new URL(url).searchParams;
  const oauthError = params.get("error");
  if (oauthError) {
    const description = params.get("error_description") || oauthError;
    console.error("[auth] OAuth provider error:", description);
    throw new Error(description);
  }
  const code = params.get("code");
  if (!code) {
    console.error("[auth] OAuth callback missing authorization code");
    throw new Error("Missing authorization code in OAuth callback.");
  }
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[auth] code exchange failed:", error.message);
    throw new Error(error.message);
  }
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

  useEffect(() => {
    if (isPinLocalDevAuthEnabled() || Platform.OS !== "web" || typeof window === "undefined") {
      return;
    }
    if (!window.location.pathname.includes("/auth/callback")) return;
    void exchangeOauthCallback(window.location.href)
      // RN-web（dev 便利形态）无登录横幅可挂：错误已在函数内 console，吞掉防
      // unhandled rejection；真机路径由 LoginScreen catch 接住进横幅。
      .catch(() => undefined)
      .finally(() => {
        window.history.replaceState({}, "", "/");
      });
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // scheme://auth/callback（app.json 的 scheme = 本环境 bundle id，与
    // Capacitor 时代同一 Supabase Redirect URLs 条目，零新增配置）。
    const redirectTo =
      Platform.OS === "web" && typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : Linking.createURL("auth/callback");
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: Platform.OS !== "web",
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw error;
    if (Platform.OS === "web") return;
    if (!data?.url) return;

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== "success") return; // 用户取消/关闭面板
    await exchangeOauthCallback(result.url);
  }, []);

  const signOut = useCallback(async () => {
    // 完整登出收口（停 sync/ambient、sweep storage、跑注册清理、supabase
    // signOut、清 TQ 缓存）——与传输层 onAuthInvalid 共用同一 performSignOut。
    await performSignOut();
  }, []);

  return { ...state, signInWithGoogle, signOut };
}
