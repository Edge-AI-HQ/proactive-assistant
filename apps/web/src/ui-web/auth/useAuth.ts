import { useState, useEffect, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { isElectron } from "./platform";
import { getDesktopBridge } from "./desktop-bridge";
import { performSignOut } from "./sign-out";
import {
  isPinLocalDevAuthEnabled,
  pinLocalDevAuthSession,
} from "./dev-auth";

/**
 * Auth hook for Supabase Google OAuth.
 *
 * Lifecycle:
 *   1. Mount → loading=true, render spinner.
 *   2. supabase fires INITIAL_SESSION (immediately on subscribe) →
 *      loading=false, session resolved.
 *   3. Subsequent SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT events keep
 *      the local state in sync.
 *
 * Flow split:
 *   - Web: redirect to Supabase, callback returns to the SPA root URL
 *     with `#access_token=...`. detectSessionInUrl=true (default) parses
 *     the hash before SIGNED_IN fires.
 *   - Electron: PKCE flow. System browser handles consent → loopback
 *     callback delivers `?code=...` via the preload bridge → exchange
 *     via `supabase.auth.exchangeCodeForSession`.
 */

/** 解析 OAuth deep-link 回调并完成 PKCE code exchange（Electron）。 */
async function exchangeOauthCallback(url: string): Promise<void> {
  const params = new URL(url).searchParams;
  const oauthError = params.get("error");
  if (oauthError) {
    console.error(
      "[auth] OAuth provider error:",
      params.get("error_description") || oauthError,
    );
    return;
  }
  const code = params.get("code");
  if (!code) {
    console.error("[auth] OAuth callback missing authorization code");
    return;
  }
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) console.error("[auth] code exchange failed:", error.message);
}

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
}

export function useAuth() {
  const localDevAuth = isPinLocalDevAuthEnabled();
  const [state, setState] = useState<AuthState>(() => {
    if (!localDevAuth) {
      return { loading: true, session: null, user: null };
    }
    const session = pinLocalDevAuthSession();
    return { loading: false, session, user: session.user };
  });

  useEffect(() => {
    if (localDevAuth) return;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ loading: false, session, user: session?.user ?? null });
    });
    return () => subscription.unsubscribe();
  }, [localDevAuth]);

  // Electron: deep link arrives from the main process via the preload
  // bridge (system browser handled the consent; macOS auto-focuses us).
  // PKCE 的 verifier 在本 renderer 的 storage 里，发起与 exchange 必须同
  // 处。Web 不需要这条分支——SPA 的 URL hash 由 detectSessionInUrl 自理。
  useEffect(() => {
    if (localDevAuth || !isElectron) return;
    return getDesktopBridge()?.onOpenUrl((url) => {
      if (!url.includes("auth/callback")) return;
      void exchangeOauthCallback(url);
    });
  }, [localDevAuth]);

  const signInWithGoogle = useCallback(async () => {
    if (localDevAuth) return;
    if (isElectron) {
      // Electron 走 loopback 回调（http://127.0.0.1:<port>/auth/callback）：
      // macOS dev 模式的 scheme deep link 不可靠（未打包无 Info.plist，
      // Launch Services 投递不保证到本进程），loopback 在 dev/打包下是
      // 同一条稳定通道。
      const redirectTo = `http://127.0.0.1:${await getDesktopBridge()!.startOauthLoopback()}/auth/callback`;
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: true,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
      if (data?.url) {
        // 独立轻量登录窗（回调即关），不打扰用户的浏览器。
        await getDesktopBridge()?.openOauthWindow(data.url);
      }
    } else {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
    }
  }, [localDevAuth]);

  // 清态 + reload 抽到 performSignOut（模块级），与传输层 onAuthInvalid 收口
  // 共用同一实现且自身幂等——失效 session 自动登出与用户主动登出走同一条路。
  const signOut = useCallback(() => performSignOut(), []);

  return { ...state, signInWithGoogle, signOut };
}
