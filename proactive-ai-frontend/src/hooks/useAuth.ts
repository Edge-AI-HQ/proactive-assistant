import { useState, useEffect, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { Browser } from "@capacitor/browser";
import { App as CapApp } from "@capacitor/app";
import { supabase } from "@/lib/supabase";
import { isNative } from "@/lib/platform";
import { clearDeviceCredentials } from "@/lib/devices";
import {
  isPinLocalDevAuthEnabled,
  pinLocalDevAuthSession,
} from "@/lib/dev-auth";

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

  // Native: receive the OAuth deep-link callback and exchange the code
  // for a session. Web doesn't need this branch — the SPA's URL hash
  // handles itself via detectSessionInUrl.
  useEffect(() => {
    if (localDevAuth || !isNative) return;
    const handle = CapApp.addListener("appUrlOpen", async ({ url }) => {
      if (!url.includes("auth/callback")) return;
      try {
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
      } finally {
        await Browser.close();
      }
    });
    return () => {
      handle.then((l) => l.remove());
    };
  }, [localDevAuth]);

  const signInWithGoogle = useCallback(async () => {
    if (localDevAuth) return;
    if (isNative) {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: OAUTH_REDIRECT_SCHEME,
          skipBrowserRedirect: true,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
      if (data?.url) await Browser.open({ url: data.url });
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

  // Full reload after signOut wipes app state cleanly — simpler than
  // coordinating per-component cleanup for multi-account flows. Also
  // sweep our session/local-storage keys so a different user signing in
  // on the same browser doesn't inherit them.
  const signOut = useCallback(async () => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("proactive-ai")) sessionStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("pinai:")) localStorage.removeItem(key);
    }
    await clearDeviceCredentials();
    if (!localDevAuth) {
      await supabase.auth.signOut();
    }
    window.location.replace("/");
  }, [localDevAuth]);

  return { ...state, signInWithGoogle, signOut };
}
