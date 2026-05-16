import { usePushNotifications } from "@/hooks/usePushNotifications";
import { isNative } from "@/lib/platform";

/**
 * Account-panel toggle for push notifications.
 *
 * The user's intent is mirrored exactly into iOS — no separate "in-app
 * pref" layer. State semantics:
 *
 *   - "prompt": tapping the toggle fires the OS system prompt. On grant
 *     we register and the backend starts dispatching. On deny iOS marks
 *     the app permanently and won't re-trigger; future taps deep-link
 *     to Settings.
 *   - "granted" / "denied": tapping deep-links to Settings (iOS doesn't
 *     allow apps to programmatically revoke their own permission, and
 *     it also won't re-show the system prompt after a denial — Settings
 *     is the only path from this point).
 *
 * The DB-side `notify_new_cards` flag is kept in sync passively by
 * ConstellationLayout's auto-sync effect — this component doesn't write
 * it directly, so the toggle is a thin OS-state mirror.
 *
 * Reactivity: usePushNotifications re-checks OS state on every
 * appStateChange:isActive event, so when the user comes back from
 * Settings the toggle reflects the new permission immediately (no
 * stale "Open Settings" prompt after they've already enabled).
 */
export default function NotificationSettings() {
  const push = usePushNotifications();

  // Hide on web (no Capacitor push) and during the initial check —
  // showing the default "prompt" state before the real value lands
  // would flash a misleading "Off" for users who already granted.
  if (!isNative || push.permissionState === "unsupported") return null;
  if (!push.ready) return null;

  const granted = push.permissionState === "granted";
  const denied = push.permissionState === "denied";

  const handleToggle = () => {
    if (granted || denied) {
      // OS is the source of truth. Only iOS Settings can flip from
      // here: granted users wanting to turn off, denied users wanting
      // to turn on.
      window.location.href = "app-settings:";
      return;
    }
    // permissionState === "prompt" or "prompt-with-rationale".
    void push.requestPermission();
  };

  const sublabel = granted
    ? "Notifying you when new cards are ready"
    : denied
      ? "Disabled in system settings — tap to open"
      : "Tap to enable";

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <h3 className="text-xs font-semibold text-foreground">New cards</h3>
        <p className="text-[11px] text-foreground/42 mt-1">{sublabel}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={granted}
        aria-label="New cards notifications"
        onClick={handleToggle}
        className={`
          relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full
          border border-foreground/10 transition-colors duration-200 ease-in-out
          ${granted ? "bg-primary" : "bg-foreground/10"}
        `}
      >
        <span
          className={`
            pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out
            ${granted ? "translate-x-[22px]" : "translate-x-[3px]"}
          `}
        />
      </button>
    </div>
  );
}
