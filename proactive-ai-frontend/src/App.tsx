import { useAuth } from "@/hooks/useAuth";
import LoginPage from "@/components/LoginPage";
import AppShell from "@/components/AppShell";

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
