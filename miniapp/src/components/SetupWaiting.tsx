import { useEffect, useRef, useState } from "react";
import Toast from "./Toast";

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 30_000;

type Props = {
  onRetry: () => Promise<void>;
  onPoll: () => Promise<void>;
  busy: boolean;
  toast: { message: string; type: "success" | "error" } | null;
  onDismissToast: () => void;
};

const SetupWaiting = ({ onRetry, onPoll, busy, toast, onDismissToast }: Props) => {
  const [timedOut, setTimedOut] = useState(false);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - startRef.current > TIMEOUT_MS) {
        setTimedOut(true);
        clearInterval(id);
        return;
      }
      void onPoll();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [onPoll]);

  return (
    <div
      className="min-h-dvh bg-pin-gradient max-w-md mx-auto flex flex-col items-center justify-center px-6"
      style={{
        paddingTop: "calc(var(--safe-top) + 1rem)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
      }}
    >
      <div className="glass-card rounded-2xl p-8 text-center w-full animate-fade-in">
        {!timedOut ? (
          <>
            <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-foreground/10 flex items-center justify-center">
              <svg className="w-7 h-7 text-foreground animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <h1 className="font-heading text-xl font-bold text-foreground">
              Setting up your agent...
            </h1>
            <p className="mt-2 text-sm text-foreground/60">
              This usually takes a few seconds.
            </p>
          </>
        ) : (
          <>
            <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-amber-100 flex items-center justify-center">
              <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h1 className="font-heading text-xl font-bold text-foreground">
              Setup is taking longer than usual
            </h1>
            <p className="mt-2 text-sm text-foreground/60">
              You can create the assistant manually.
            </p>
            <button
              className="mt-5 w-full rounded-xl bg-foreground text-background px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
              onClick={() => void onRetry()}
              disabled={busy}
            >
              {busy ? "Creating..." : "Create Assistant"}
            </button>
          </>
        )}
      </div>

      <Toast message={toast?.message ?? null} type={toast?.type} onDismiss={onDismissToast} />
    </div>
  );
};

export default SetupWaiting;
