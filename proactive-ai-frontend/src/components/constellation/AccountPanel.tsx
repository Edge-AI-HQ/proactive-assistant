import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import {
  Sparkles, Check, Bell, SlidersHorizontal, ShieldCheck,
  AlertTriangle, Loader2,
} from "lucide-react";
import NotificationSettings from "@/components/NotificationSettings";

export interface AccountPanelProps {
  /** Display name shown on the profile card. Falls back to email prefix. */
  userName?: string;
  /** Single-letter avatar shown in the round chip. Falls back to first initial of userName. */
  avatarLetter?: string;
  /** Email shown on the profile card subtitle. */
  userEmail?: string;
  /** Human-readable join date, e.g. "Mar 2024". Optional — falls back to "Member" only. */
  memberSince?: string;
  /** Optional sign-out handler. When provided, replaces the Edit button with Sign out. */
  onSignOut?: () => void;
  /**
   * Optional destructive-delete handler. When provided, surfaces a
   * Danger Zone card at the bottom of the panel with a typed-confirm
   * flow. The handler is expected to delete the account AND sign the
   * user out (page-reload included) on success, so this component only
   * needs to surface its own loading + error UI. Throws on failure so
   * the panel can show the message and let the user retry.
   */
  onDeleteAccount?: () => Promise<void>;
}

export default function AccountPanel({
  userName = "Account",
  avatarLetter,
  userEmail,
  memberSince,
  onSignOut,
  onDeleteAccount,
}: AccountPanelProps = {}) {
  const initial = (avatarLetter ?? userName.trim().slice(0, 1) ?? "?").toUpperCase();
  const subtitle = memberSince
    ? `${userEmail ?? ""}${userEmail ? " · " : ""}Member since ${memberSince}`
    : (userEmail ?? "Signed in");

  // Two-step disclosure: collapsed Danger Zone shows just the Delete
  // button; clicking expands the typed-confirm form. Self-contained UI
  // state — the action itself is the prop.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleConfirmDelete = useCallback(async () => {
    if (!onDeleteAccount || confirmText !== "DELETE") return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteAccount();
      // On success the parent reloads the page; reaching here only
      // happens transiently before the reload fires.
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }, [onDeleteAccount, confirmText]);

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      {/* Header */}
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Account</h1>
      <p className="text-xs text-muted-foreground mb-5">Profile · Subscription · Preferences</p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        {/* Profile card */}
        <div className="glass-card-strong p-4 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0">
            <span className="text-base font-semibold text-foreground/70">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{userName}</p>
            <p className="text-[11px] text-foreground/50 truncate">{subtitle}</p>
          </div>
          {onSignOut ? (
            <button
              onClick={onSignOut}
              className="text-[11px] font-medium text-foreground border border-foreground/12 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors"
            >
              Sign out
            </button>
          ) : (
            <button className="text-[11px] font-medium text-foreground border border-foreground/12 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors">
              Edit
            </button>
          )}
        </div>

        {/* Subscription & Billing */}
        <div className="glass-card-strong p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
              <Sparkles size={16} strokeWidth={1.5} className="text-foreground/70" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Subscription & Billing</p>
              <p className="text-[11px] text-foreground/50 mt-0.5">Current: Pro · 7-day trial</p>
            </div>
          </div>

          {/* Basic */}
          <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-foreground">Basic</span>
                <span className="text-base font-semibold text-foreground">$39</span>
                <span className="text-[11px] text-foreground/40">/ mo</span>
              </div>
              <button className="text-[11px] font-semibold text-foreground border border-foreground/15 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors">
                Switch
              </button>
            </div>
            <p className="text-[11px] text-foreground/55 mb-2">1,500 credits / mo · Local Gemma 2B · Cloud Gemini Flash</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {["Daily card feed", "Connect 3 apps", "Email + Calendar"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.5} className="text-foreground/40 flex-shrink-0" />
                  <span className="text-[11px] text-foreground/55">{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pro (current / most popular) */}
          <div className="relative rounded-2xl border-2 border-[hsl(304_75%_63%/0.45)] bg-[hsl(304_75%_63%/0.04)] p-3.5">
            <div className="absolute -top-2.5 right-3 bg-[hsl(304_75%_63%)] text-white text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full">
              Current · Most Popular
            </div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-foreground">Pro</span>
                <span className="text-base font-semibold text-[hsl(304_75%_63%)]">$99</span>
                <span className="text-[11px] text-foreground/40">/ mo</span>
              </div>
              <span className="text-[11px] font-medium text-[hsl(304_75%_63%)]">Active</span>
            </div>
            <p className="text-[11px] text-foreground/60 mb-2">6,000 credits / mo · Local Llama 3 8B · Cloud Claude Sonnet</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {["Everything in Basic", "Connect unlimited apps", "Voice + Ambient mode", "Priority execution"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.5} className="text-[hsl(304_75%_63%)] flex-shrink-0" />
                  <span className="text-[11px] text-foreground/70">{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Max */}
          <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-foreground">Max</span>
                <span className="text-base font-semibold text-foreground">$199</span>
                <span className="text-[11px] text-foreground/40">/ mo</span>
              </div>
              <button className="text-[11px] font-semibold text-background bg-foreground rounded-lg px-3 py-1 hover:opacity-90 transition-opacity">
                Upgrade
              </button>
            </div>
            <p className="text-[11px] text-foreground/55 mb-2">20,000 credits / mo · Local Llama 3 70B · Cloud Claude Opus / GPT-5</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {["Everything in Pro", "Custom personas", "Team sharing", "Early access models"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.5} className="text-foreground/40 flex-shrink-0" />
                  <span className="text-[11px] text-foreground/55">{f}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Push Notifications — interactive toggle. OS permission +
            app preference are reconciled by NotificationSettings; on
            web (no Capacitor push) this renders nothing. */}
        <div className="glass-card-strong p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
              <Bell size={16} strokeWidth={1.5} className="text-foreground/70" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">Push Notifications</p>
              <p className="text-[11px] text-foreground/50 mt-0.5">
                Get notified when new cards are ready
              </p>
            </div>
          </div>
          <NotificationSettings />
        </div>

        {/* Section rows — placeholder targets for future Preferences /
            Privacy & Data screens. The buttons are non-interactive on
            purpose; wire them up when those screens exist. */}
        {[
          { icon: SlidersHorizontal, name: "Preferences", desc: "Quiet hours, voice, tone" },
          { icon: ShieldCheck, name: "Privacy & Data", desc: "On-device by default · TEE-protected" },
        ].map((row) => {
          const RowIcon = row.icon;
          return (
            <button
              key={row.name}
              className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
            >
              <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
                <RowIcon size={16} strokeWidth={1.5} className="text-foreground/70" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{row.name}</p>
                <p className="text-[11px] text-foreground/50 mt-0.5">{row.desc}</p>
              </div>
            </button>
          );
        })}

        {/* Danger Zone — bottom of the panel, last destructive surface. */}
        {onDeleteAccount && (
          <div className="glass-card-strong p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={16} strokeWidth={1.5} className="text-red-600" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">Delete Account</p>
                <p className="text-[11px] text-foreground/50 mt-0.5">
                  Permanently erase your account and all associated data. Cannot be undone.
                </p>
              </div>
            </div>

            {!deleteOpen ? (
              <button
                onClick={() => {
                  setDeleteOpen(true);
                  setConfirmText("");
                  setDeleteError(null);
                }}
                className="w-full rounded-2xl border border-red-200 bg-red-50/40 text-red-700 text-[11px] font-medium py-2 transition-colors hover:bg-red-50"
              >
                Delete Account
              </button>
            ) : (
              <div className="space-y-2 rounded-2xl border border-red-200 bg-red-50/40 p-3">
                <p className="text-[11px] leading-snug text-red-700">
                  This permanently erases your account, memories, signals, cards,
                  feedback, connectors, raw data, skills, subscription, and uploaded
                  media. Type <span className="font-mono font-semibold">DELETE</span> to confirm.
                </p>
                <input
                  type="text"
                  autoFocus
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="DELETE"
                  disabled={deleting}
                  className="w-full rounded-md border border-red-200 bg-white px-2 py-1.5 text-[11px] font-mono text-red-700 placeholder-red-300 focus:outline-none focus:ring-1 focus:ring-red-400 disabled:opacity-50"
                />
                {deleteError && (
                  <p className="text-[10px] text-red-700 leading-snug">{deleteError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setDeleteOpen(false);
                      setConfirmText("");
                      setDeleteError(null);
                    }}
                    disabled={deleting}
                    className="flex-1 rounded-md border border-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors hover:bg-foreground/5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleConfirmDelete()}
                    disabled={deleting || confirmText !== "DELETE"}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-red-600 text-white text-[11px] font-semibold py-1.5 transition-colors hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deleting ? (
                      <>
                        <Loader2 size={11} className="animate-spin" />
                        Deleting...
                      </>
                    ) : "Delete forever"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
