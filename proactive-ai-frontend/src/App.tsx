import { useEffect, useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import LoginPage from "@/components/LoginPage";
import ConstellationLayout from "@/components/constellation/ConstellationLayout";
import { isNative } from "@/lib/platform";
import { useUserSettings } from "@/hooks/useUserSettings";
import { getPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS, type SourceKey } from "@/services/ambient/keys";

/**
 * Top-level router after the apis + openclaw retirement:
 *   loading → spinner
 *   no user → LoginPage (Supabase Google OAuth)
 *   user    → ConstellationLayout (v2026-05-14)
 *
 * The old `AppShell` is kept in `src/components/AppShell.tsx` for reference
 * but no longer mounted. ConstellationLayout owns the 7-view shell + card
 * drawer + fullscreen chat overlay; the card execution chat runtime
 * (CardChat → MainChatView via useProactiveChatRuntime) is unchanged.
 */
export default function App() {
  const { loading: authLoading, user, signInWithGoogle } = useAuth();
  // Opt-in start the ambient sources the user has explicitly enabled.
  // Never autoStart — privacy invariant per V3 migration plan D-5.
  // AmbientSourcesPanel handles per-toggle reconciliation while open;
  // this effect is the boot-time path that runs even when the debug
  // panel is closed.
  const { settings: userSettings } = useUserSettings();
  // Stable key signature so unrelated settings changes (autoGenerate,
  // language, etc.) don't re-trigger the reconcile. We deliberately
  // distinguish "settings not yet loaded" (null) from "loaded, empty
  // opt-in" (""): the empty string still needs to fire so a user who
  // just turned everything off has the runtime stop matching sources.
  const enabledKey: string | null = useMemo(() => {
    if (getPersistedAmbientEnabled()) return ALL_SOURCE_KEYS.join(",");
    const c = userSettings?.ambientSources;
    if (c === undefined) return null;
    return Object.entries(c ?? {})
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k)
      .sort()
      .join(",");
  }, [userSettings?.ambientSources]);

  useEffect(() => {
    if (!isNative || !user) return;
    let cancelled = false;
    void import("@/lib/devices").then(async ({ ensureDevice }) => {
      try {
        await ensureDevice({ forceRefresh: true });
      } catch (err) {
        if (!cancelled) {
          console.warn("[devices] registration failed after sign-in", err);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!isNative || !user || enabledKey === null) return;
    const enabled = enabledKey ? enabledKey.split(",") as SourceKey[] : [];
    void import("@/services/ambient/lifecycle").then(({ startAmbientUpload }) => {
      startAmbientUpload({ enabledSources: enabled });
    });
  }, [user, enabledKey]);

  if (authLoading) {
    return (
      <div className="relative flex h-full items-center justify-center overflow-hidden">
        <div className="absolute inset-0 animate-bg-flow opacity-60" />
        <div className="absolute inset-0 bg-white/20" />
        <div className="relative z-10 h-8 w-8 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
      </div>
    );
  }

  // Dev convenience: `?preview=1` skips Supabase auth so the Constellation
  // visual can be inspected without a real session. Remove before shipping.
  const previewBypass =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("preview");

  if (!user && !previewBypass) {
    return <LoginPage onSignIn={signInWithGoogle} />;
  }

  return (
    <MemoryRouter>
      <ConstellationLayout />
    </MemoryRouter>
  );
}
