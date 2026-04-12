import { useState, useEffect, useCallback, useRef } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { Browser } from "@capacitor/browser";
import { App as CapApp } from "@capacitor/app";
import { supabase } from "@/lib/supabase";
import { isNative } from "@/lib/platform";

const OAUTH_REDIRECT_SCHEME = "ai.pin.proactive://auth/callback";

/** Keys written by application code that must be purged on sign-out. */
const APP_SESSION_STORAGE_KEYS = ["proactive-ai-run-state"];
const APP_LOCAL_STORAGE_KEYS = ["openclaw.control.settings.v1"];

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
    user: null,
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setState((s) => ({ ...s, loading: false, session, user: session?.user ?? null }));
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState((s) => ({
        ...s,
        loading: false,
        session,
        user: session?.user ?? null,
      }));
    });

    return () => subscription.unsubscribe();
  }, []);

  // Native: listen for deep-link callback from OAuth redirect
  useEffect(() => {
    if (!isNative) return;

    const listener = CapApp.addListener("appUrlOpen", async ({ url }) => {
      if (!url.includes("auth/callback")) return;

      const params = new URL(url).searchParams;
      const code = params.get("code");
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
      }
      await Browser.close();
    });

    return () => {
      listener.then((l) => l.remove());
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
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
      if (data?.url) {
        await Browser.open({ url: data.url });
      }
    } else {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/proactive/`,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
    }
  }, []);

  const signOutRef = useRef(false);
  const signOut = useCallback(async () => {
    if (signOutRef.current) return; // prevent double-click
    signOutRef.current = true;
    try {
      for (const key of APP_SESSION_STORAGE_KEYS) sessionStorage.removeItem(key);
      for (const key of APP_LOCAL_STORAGE_KEYS) localStorage.removeItem(key);
      await supabase.auth.signOut();
      // Full page reload wipes all in-memory state (React state, closures,
      // module-level singletons) — the standard approach for multi-account flows.
      window.location.replace("/proactive/");
    } catch {
      signOutRef.current = false;
    }
  }, []);

  return {
    ...state,
    signInWithGoogle,
    signOut,
  };
}
