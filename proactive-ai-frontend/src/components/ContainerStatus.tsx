import type { ContainerState } from "@/hooks/useContainer";

interface ContainerStatusProps {
  status: ContainerState;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const statusConfig: Record<
  ContainerState,
  { label: string; color: string; animate?: boolean }
> = {
  none: { label: "No container", color: "text-foreground/40" },
  creating: { label: "Creating your environment...", color: "text-blue-500", animate: true },
  running: { label: "Ready", color: "text-green-500" },
  stopped: { label: "Container stopped", color: "text-amber-500" },
  suspended: { label: "Resuming...", color: "text-blue-500", animate: true },
  error: { label: "Container error", color: "text-red-500" },
  missing: { label: "Container missing", color: "text-red-500" },
};

export default function ContainerStatus({
  status,
  loading,
  error,
  onRetry,
}: ContainerStatusProps) {
  const config = statusConfig[status];
  const showOverlay = status !== "running";

  if (!showOverlay) return null;

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />

      <div className="relative z-10 w-full max-w-sm glass-card-strong p-8 text-center">
        <div className="mb-4">
          {(loading || config.animate) && (
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
          )}
          <p className={`text-lg font-medium ${config.color}`}>
            {config.label}
          </p>
        </div>

        {error && (
          <p className="mb-4 text-sm text-red-500">{error}</p>
        )}

        {(status === "error" || status === "missing" || status === "stopped") && (
          <button
            onClick={onRetry}
            className="rounded-xl bg-foreground px-6 py-2.5 text-sm font-medium text-background shadow-sm transition-colors hover:bg-foreground/85"
          >
            Retry
          </button>
        )}

        {status === "creating" && (
          <p className="text-sm text-muted-foreground">
            This may take 30-60 seconds on first launch.
          </p>
        )}
      </div>
    </div>
  );
}
