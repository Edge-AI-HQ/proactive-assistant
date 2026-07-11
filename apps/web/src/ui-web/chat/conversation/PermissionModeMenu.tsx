import { useEffect, useRef, useState } from "react";
import { Check, ChevronUp, Shield, ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUserSettings, type PermissionMode } from "@pin-ai/state";
import { Text } from "../../primitives/Text";

// Selectable permission modes, in menu order. Add a future mode here + a
// matching backend CHECK + i18n label under composer.permission.<mode>.
// 'bypass' removes the HITL approval gate on side-effect tools, so it's the
// dangerous option: destructive accent + an explicit confirm before switching
// in (switching back to a gated mode is immediate — fail-safe).
const MODES: readonly PermissionMode[] = ["ask", "bypass"];

/**
 * Permission-mode selector shown under the composer (replaces the old bool
 * toggle). Shows the current mode; clicking opens a pull-up menu to switch.
 * Persisted + cross-device via user-settings; the per-run runtime effect is
 * applied by ConversationView (maps `bypass` → the per-run bypass flag).
 */
export function PermissionModeMenu() {
  const { t } = useTranslation("chat");
  const { settings, saving, error: settingsError, patch } = useUserSettings();
  const mode = settings?.permissionMode ?? "ask";
  const [open, setOpen] = useState(false);
  const [pendingBypass, setPendingBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss the pop-up on outside click / Escape (standard menu behavior).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = async (next: PermissionMode) => {
    setError(null);
    const result = await patch({ permissionMode: next });
    if (!result) setError(settingsError ?? t("composer.permission.saveFailed"));
  };

  const onSelect = (next: PermissionMode) => {
    setOpen(false);
    if (next === mode) return;
    // Switching INTO bypass removes the only human gate on outbound actions —
    // confirm first. Switching back to a gated mode is immediate (fail-safe).
    if (next === "bypass") {
      setPendingBypass(true);
      return;
    }
    void apply(next);
  };

  const bypassed = mode === "bypass";

  return (
    <div ref={rootRef} className="relative px-2 pt-1.5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={saving}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors hover:bg-foreground/[0.06] disabled:opacity-40"
      >
        {bypassed ? (
          <ShieldOff size={13} strokeWidth={2} className="shrink-0 text-destructive" />
        ) : (
          <Shield size={13} strokeWidth={2} className="shrink-0 text-foreground/40" />
        )}
        <Text variant="label" className={bypassed ? "text-destructive" : "text-foreground/55"}>
          {t(`composer.permission.${mode}`)}
        </Text>
        <ChevronUp
          size={12}
          strokeWidth={2}
          className={`shrink-0 text-foreground/40 transition-transform ${open ? "" : "rotate-180"}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-2 z-20 mb-1 min-w-[200px] overflow-hidden rounded-2xl border border-foreground/[0.08] bg-background py-1 shadow-lg"
        >
          <Text variant="label" className="block px-3 py-1 text-foreground/40">
            {t("composer.permission.menuTitle")}
          </Text>
          {MODES.map((m) => {
            const active = m === mode;
            const danger = m === "bypass";
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => onSelect(m)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.06]"
              >
                <span className="flex w-4 shrink-0 justify-center">
                  {active && <Check size={14} strokeWidth={2.5} className="text-foreground/70" />}
                </span>
                <Text
                  variant="label"
                  className={danger ? "text-destructive" : "text-foreground/80"}
                >
                  {t(`composer.permission.${m}`)}
                </Text>
              </button>
            );
          })}
        </div>
      )}

      {pendingBypass && (
        <div className="mt-1.5 rounded-2xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
          <Text variant="label" className="leading-snug text-foreground/70">
            {t("composer.permission.confirmBody")}
          </Text>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingBypass(false)}
              className="rounded-lg px-2.5 py-1 transition-colors hover:bg-foreground/[0.06]"
            >
              <Text variant="label" className="text-foreground/55">
                {t("composer.permission.cancel")}
              </Text>
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setPendingBypass(false);
                void apply("bypass");
              }}
              className="rounded-lg bg-destructive px-2.5 py-1 transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Text variant="label" weight="medium" className="text-white">
                {t("composer.permission.confirm")}
              </Text>
            </button>
          </div>
        </div>
      )}

      {error && (
        <Text variant="label" className="mt-1 block text-destructive">
          {error}
        </Text>
      )}
    </div>
  );
}
