import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";

/**
 * In-app pre-prompt for notification permission. Mounts once per user
 * (gated on settings.notifyPermissionPromptedAt being null + native
 * runtime) on the first home-screen visit after sign-in.
 *
 * Why a pre-prompt before the OS prompt:
 *   - We can explain the WHY (async card generation). The OS dialog
 *     only gets one short system-rendered line.
 *   - Once denied at the OS level, iOS won't show that prompt again.
 *     If the user is in the "not sure" zone, the pre-prompt lets them
 *     defer without burning the OS permission slot.
 *
 * Both CTAs stamp notifyPermissionPromptedAt server-side so we never
 * re-show this automatically. The Account → Notifications toggle is
 * the only way to revisit the choice.
 *
 * Rendered as a plain bottom-sheet modal (NOT a vaul Drawer): this sheet
 * auto-opens during the post-login boot render cascade, and vaul's
 * iOS-only `position: fixed` body machinery + Radix Dialog presence then
 * infinite-loop inside the WKWebView (React #185 — only reproduces on a
 * fresh iOS account, where this is the one drawer that auto-opens). An
 * informational prompt needs none of vaul's drag / snap / scale features,
 * so a static modal is both the correct altitude and loop-proof.
 */
export interface PreNotificationPromptProps {
  open: boolean;
  /** Called when the user taps "Turn on". Should request OS permission
   * and stamp notifyPermissionPromptedAt + (on grant) notifyNewCards=true.
   * Resolves after the parent finishes its write so the sheet stays
   * mounted during the network round-trip — no flash-of-empty. */
  onAccept: () => Promise<void>;
  /** Called when the user taps "Later". Should stamp
   * notifyPermissionPromptedAt only (don't touch notifyNewCards). */
  onDecline: () => Promise<void>;
}

export function PreNotificationPrompt({
  open,
  onAccept,
  onDecline,
}: PreNotificationPromptProps) {
  const [busy, setBusy] = useState(false);

  const handleAccept = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  }, [busy, onAccept]);

  const handleDecline = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecline();
    } finally {
      setBusy(false);
    }
  }, [busy, onDecline]);

  // Escape = "Later" (mirrors the old drawer's swipe-down / tap-outside
  // dismiss, which also routed to onDecline so the prompted_at stamp lands).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void handleDecline();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleDecline]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prenotif-title"
      aria-describedby="prenotif-desc"
    >
      {/* Backdrop — tapping outside counts as "Later", same outcome as the
          explicit button, so we don't drop the prompted_at stamp. */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => void handleDecline()}
      />
      <div className="relative z-10 mx-auto w-full max-w-md rounded-t-[10px] border bg-background pb-6">
        <div className="flex flex-col items-center gap-3 p-4 pt-5 text-center">
          <div className="rounded-full bg-primary/10 p-3">
            <Bell className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <h2
            id="prenotif-title"
            className="text-lg font-semibold leading-none tracking-tight"
          >
            Turn on notifications
          </h2>
          <p
            id="prenotif-desc"
            className="text-base leading-relaxed text-muted-foreground"
          >
            Generating cards can take a few minutes to a few hours. With
            notifications on, we'll alert you the moment they're ready — no need
            to keep watching the app.
          </p>
        </div>
        <div className="flex flex-col gap-2 p-4">
          <button
            type="button"
            onClick={handleAccept}
            disabled={busy}
            className="w-full rounded-md bg-primary text-primary-foreground py-3 text-sm font-medium disabled:opacity-60"
          >
            Turn on
          </button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={busy}
            className="w-full rounded-md bg-transparent text-muted-foreground py-3 text-sm disabled:opacity-60"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
