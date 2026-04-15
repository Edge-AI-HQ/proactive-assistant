import { useAuth } from "@/hooks/useAuth";
import { useContainer } from "@/hooks/useContainer";
import LoginPage from "@/components/LoginPage";
import Dashboard from "@/components/Dashboard";
import AppShell from "@/components/AppShell";

export default function App() {
  const { loading: authLoading, user, signInWithGoogle, signOut } = useAuth();
  const { status, loading: containerLoading, initialChecking, error, ensure, cancel } = useContainer(!!user);

  if (authLoading || (user && initialChecking)) {
    return (
      <div className="relative flex h-full items-center justify-center overflow-hidden">
        <div className="absolute inset-0 animate-bg-flow opacity-60" />
        <div className="absolute inset-0 bg-white/20" />
        <div className="relative z-10 h-8 w-8 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
      </div>
    );
  }

  // Not authenticated
  if (!user) {
    return <LoginPage onSignIn={signInWithGoogle} />;
  }

  // Authenticated + container running
  if (status === "running") {
    return (
      <AppShell
        userName={user.user_metadata?.full_name ?? user.email ?? null}
        onSignOut={signOut}
      />
    );
  }

  // All other states: show Dashboard with inline container status
  return (
    <Dashboard
      user={user}
      containerStatus={status}
      containerLoading={containerLoading}
      containerError={error}
      onSignOut={signOut}
      onLaunchContainer={ensure}
      onStopContainer={cancel}
    />
  );
}
