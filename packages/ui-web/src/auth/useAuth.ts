import { useState, useEffect, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { Browser } from "@capacitor/browser";
import { App as CapApp } from "@capacitor/app";
import { supabase } from "./supabase";
import { isElectron, isNative } from "./platform";
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
 *   - Native: PKCE flow. Open external browser → Capacitor App's
 *     `appUrlOpen` event delivers the deep-link with `?code=...` →
 *     exchange via `supabase.auth.exchangeCodeForSession`.
 */

// Per-env: scheme = this build's bundle id, injected via VITE_OAUTH_SCHEME at
// build time (see build-ios.sh). Lets dev (`ai.pin.proactive.development`) and prod
// (`ai.pin.proactive`) apps coexist on one device without their OAuth callbacks
// colliding. Falls back to the prod scheme for web / local builds that omit it.
const OAUTH_REDIRECT_SCHEME = `${import.meta.env.VITE_OAUTH_SCHEME || "ai.pin.proactive"}://auth/callback`;

/** 解析 OAuth deep-link 回调并完成 PKCE code exchange（native/Electron 共用）。 */
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

  // Native / Electron: receive the OAuth deep-link callback and exchange
  // the code for a session (PKCE; verifier lives in this renderer's
  // storage, so initiation and exchange must both happen here). Web
  // doesn't need this branch — the SPA's URL hash handles itself via
  // detectSessionInUrl.
  useEffect(() => {
    if (localDevAuth || !isNative) return;
    const handle = CapApp.addListener("appUrlOpen", async ({ url }) => {
      if (!url.includes("auth/callback")) return;
      try {
        await exchangeOauthCallback(url);
      } finally {
        await Browser.close();
      }
    });
    return () => {
      handle.then((l) => l.remove());
    };
  }, [localDevAuth]);

  // Electron: deep link arrives from the main process via the preload
  // bridge (system browser handled the consent; macOS auto-focuses us).
  useEffect(() => {
    if (localDevAuth || !isElectron) return;
    return getDesktopBridge()?.onOpenUrl((url) => {
      if (!url.includes("auth/callback")) return;
      void exchangeOauthCallback(url);
    });
  }, [localDevAuth]);

  const signInWithGoogle = useCallback(async () => {
    if (localDevAuth) return;
    if (isNative || isElectron) {
      // Electron 走 loopback 回调（http://127.0.0.1:<port>/auth/callback）：
      // macOS dev 模式的 scheme deep link 不可靠（未打包无 Info.plist，
      // Launch Services 投递不保证到本进程），loopback 在 dev/打包下是
      // 同一条稳定通道。native 仍走 app scheme。
      const redirectTo = isElectron
        ? `http://127.0.0.1:${await getDesktopBridge()!.startOauthLoopback()}/auth/callback`
        : OAUTH_REDIRECT_SCHEME;
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
        // Electron：独立轻量登录窗（回调即关），不打扰用户的浏览器。
        if (isElectron) await getDesktopBridge()?.openOauthWindow(data.url);
        else await Browser.open({ url: data.url });
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
