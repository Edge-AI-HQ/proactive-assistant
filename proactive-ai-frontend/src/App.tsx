import { useEffect, useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import LoginPage from "@/components/LoginPage";
import ConstellationLayout from "@/components/constellation/ConstellationLayout";
import { VoiceProvider } from "@/components/voice";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
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
function Spinner() {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />
      <div className="relative z-10 h-8 w-8 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
    </div>
  );
}

// Shown when the settings bootstrap fails after its retries. The retry
// button re-issues the fetch in place — no app restart needed.
function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />
      <div className="relative z-10 w-full max-w-sm glass-card-strong p-8 text-center">
        <p className="text-sm text-foreground/80">
          Couldn't reach the server. Check your connection and try again.
        </p>
        <button
          onClick={onRetry}
          className="mt-5 w-full rounded-xl border border-foreground/10 bg-white/60 px-4 py-3 text-sm font-medium text-foreground/80 shadow-sm transition-colors hover:bg-white/80"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { loading: authLoading, user, signInWithGoogle } = useAuth();
  // Opt-in start the ambient sources the user has explicitly enabled.
  // Never autoStart — privacy invariant per V3 migration plan D-5.
  // AmbientSourcesPanel handles per-toggle reconciliation while open;
  // this effect is the boot-time path that runs even when the debug
  // panel is closed.
  const {
    settings: userSettings,
    loading: settingsLoading,
    patch: patchSettings,
    refetch: refetchSettings,
  } = useUserSettings();
  // Stable key signature so unrelated settings changes (autoGenerate,
  // language, etc.) don't re-trigger the reconcile. We deliberately
  // distinguish "settings not yet loaded" (null) from "loaded, empty
  // opt-in" (""): the empty string still needs to fire so a user who
  // just turned everything off has the runtime stop matching sources.
  const enabledKey: string | null = useMemo(() => {
    if (!userSettings) return null;
    if (getPersistedAmbientEnabled()) return ALL_SOURCE_KEYS.join(",");
    const c = userSettings.ambientSources;
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
      startAmbientUpload({
        enabledSources: enabled,
        transcriptionLanguage: userSettings?.generationLanguage ?? null,
      });
    });
  }, [user, enabledKey, userSettings?.generationLanguage]);

  if (authLoading) {
    return <Spinner />;
  }

  // Dev convenience: `?preview=1` skips Supabase auth so the Constellation
  // visual can be inspected without a real session. Remove before shipping.
  const previewBypass =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("preview");

  if (!user && !previewBypass) {
    return <LoginPage onSignIn={signInWithGoogle} />;
  }

  // Authenticated path needs settings before we can decide between
  // onboarding and the main shell — gate on the first /settings response
  // so the user never sees the main UI flash before being redirected into
  // onboarding. Three states (never an unbounded spinner): in-flight →
  // spinner; failed after retries (loaded but still null) → actionable
  // retry screen; loaded → fall through. previewBypass skips this since
  // it never has a user/settings to fetch.
  if (!previewBypass && settingsLoading) {
    return <Spinner />;
  }
  if (!previewBypass && userSettings === null) {
    return <BootstrapError onRetry={() => void refetchSettings()} />;
  }

  if (!previewBypass && userSettings && !userSettings.onboardingCompletedAt) {
    return (
      <OnboardingFlow
        onComplete={async () => {
          const next = await patchSettings({ onboardingCompleted: true });
          if (next === null) {
            throw new Error("Couldn't save your onboarding progress. Check your connection and try again.");
          }
        }}
      />
    );
  }

  return (
    <MemoryRouter>
      <VoiceProvider transcriptionLanguage={userSettings?.generationLanguage ?? null}>
        <ConstellationLayout />
      </VoiceProvider>
    </MemoryRouter>
  );
}
