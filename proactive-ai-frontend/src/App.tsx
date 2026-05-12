import { useEffect, useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";
import LoginPage from "@/components/LoginPage";
import AppShell from "@/components/AppShell";
import { isNative } from "@/lib/platform";
import { useUserSettings } from "@/hooks/useUserSettings";
import type { SourceKey } from "@/services/ambient";

/**
 * Top-level router after the apis + openclaw retirement:
 *   loading → spinner
 *   no user → LoginPage (Supabase Google OAuth)
 *   user    → AppShell directly
 *
 * The pre-cutover Dashboard / useContainer flow waited on a per-user
 * OpenClaw container to spin up. There's no per-user container anymore
 * (pinai-agents is multi-tenant), so login lands the user straight in
 * the chat shell.
 */
export default function App() {
  const { loading: authLoading, user, signInWithGoogle, signOut } = useAuth();
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
    const c = userSettings?.ambientSources;
    if (c === undefined) return null;
    return Object.entries(c ?? {})
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k)
      .sort()
      .join(",");
  }, [userSettings?.ambientSources]);
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

  if (!user) {
    return <LoginPage onSignIn={signInWithGoogle} />;
  }

  return (
    <AppShell
      userName={user.user_metadata?.full_name ?? user.email ?? null}
      onSignOut={signOut}
    />
  );
}
