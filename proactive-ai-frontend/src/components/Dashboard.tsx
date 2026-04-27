import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { ContainerState } from "@/hooks/useContainer";
import { LogOut, Rocket, RefreshCw, Square, Trash2 } from "lucide-react";

interface DashboardProps {
  user: User;
  status: ContainerState;
  connectAttempt: number;
  connectMaxAttempts: number;
  firstTime: boolean;
  error: string | null;
  onSignOut: () => void;
  onRecreate: () => Promise<unknown> | unknown;
  onReconnect: () => void;
  onCancel: () => Promise<void>;
}

export default function Dashboard({
  user,
  status,
  connectAttempt,
  connectMaxAttempts,
  firstTime,
  error,
  onSignOut,
  onRecreate,
  onReconnect,
  onCancel,
}: DashboardProps) {
  const [actionInProgress, setActionInProgress] = useState(false);

  const name = user.user_metadata?.full_name ?? user.email ?? "User";
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;
  const email = user.email ?? "";
  const provider = user.app_metadata?.provider ?? "unknown";

  const handle = async (fn: () => Promise<unknown> | unknown) => {
    setActionInProgress(true);
    try {
      await fn();
    } finally {
      setActionInProgress(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />

      <div className="relative z-10 w-full max-w-sm glass-card-strong p-8">
        {/* User Info */}
        <div className="flex items-center gap-4 mb-6">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={name}
              className="h-12 w-12 rounded-full border border-foreground/10"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground/10 text-foreground/60 text-lg font-medium">
              {name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{name}</p>
            <p className="text-xs text-foreground/50 truncate">{email}</p>
            <p className="text-[10px] text-foreground/30 mt-0.5 capitalize">{provider}</p>
          </div>
        </div>

        <div className="h-px bg-foreground/10 mb-6" />

        {/* Container status panel */}
        <div className="text-center mb-6">
          {status === "unknown" && (
            <>
              <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
              <p className="text-sm text-foreground/60">Checking your environment…</p>
            </>
          )}

          {status === "connecting" && (
            <>
              <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
              <p className="text-sm text-blue-500 font-medium mb-1">
                Connecting to your environment…
              </p>
              <p className="text-xs text-foreground/40 mb-4">
                Attempt {Math.max(connectAttempt, 1)} / {connectMaxAttempts}. First boot can take up to a minute.
              </p>
              <button
                onClick={() => handle(onCancel)}
                disabled={actionInProgress}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-foreground/15 px-6 py-2.5 text-sm font-medium text-foreground/60 transition-colors hover:text-foreground/80 hover:bg-foreground/5 disabled:opacity-50"
              >
                <Square size={14} />
                Cancel
              </button>
            </>
          )}

          {status === "unhealthy" && firstTime && (
            <>
              <p className="text-sm text-foreground/60 mb-4">
                Launch your personal AI environment to get started.
              </p>
              {error && (
                <p className="text-xs text-amber-500/80 mb-4">{error}</p>
              )}
              <button
                onClick={() => handle(onRecreate)}
                disabled={actionInProgress}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-6 py-3 text-sm font-medium text-background shadow-sm transition-colors hover:bg-foreground/85 disabled:opacity-50"
              >
                {actionInProgress ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-background/30 border-t-background" />
                    Starting…
                  </>
                ) : (
                  <>
                    <Rocket size={16} />
                    Start your assistant
                  </>
                )}
              </button>
            </>
          )}

          {status === "unhealthy" && !firstTime && (
            <>
              <p className="text-sm text-red-500 font-medium mb-1">
                Can't reach your environment
              </p>
              <p className="text-xs text-foreground/50 mb-4">
                {error ?? "The container didn't respond. Try reconnecting, or recreate it if the problem persists."}
              </p>
              <button
                onClick={() => handle(onReconnect)}
                disabled={actionInProgress}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-6 py-3 text-sm font-medium text-background shadow-sm transition-colors hover:bg-foreground/85 disabled:opacity-50 mb-2"
              >
                <RefreshCw size={16} />
                Reconnect
              </button>
              <button
                onClick={() => handle(onRecreate)}
                disabled={actionInProgress}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/30 px-6 py-2.5 text-sm font-medium text-red-500 transition-colors hover:bg-red-500/5 disabled:opacity-50"
              >
                <Trash2 size={14} />
                Recreate container
              </button>
            </>
          )}
        </div>

        {/* Sign Out */}
        <button
          onClick={onSignOut}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-foreground/10 px-4 py-2.5 text-xs text-foreground/50 transition-colors hover:text-foreground/70 hover:bg-foreground/5"
        >
          <LogOut size={14} />
          Sign Out
        </button>
      </div>
    </div>
  );
}
