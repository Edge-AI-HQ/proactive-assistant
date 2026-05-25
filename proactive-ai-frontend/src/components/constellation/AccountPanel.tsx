import { lazy, Suspense, useState } from "react";
import { motion } from "framer-motion";
import {
  Sparkles, Check, Bell, SlidersHorizontal, Radio, ChevronRight, ArrowLeft,
  CreditCard, Calendar, AlertTriangle, Receipt,
} from "lucide-react";
import AutoDreamingSettings from "@/components/AutoDreamingSettings";
import AutoGenerateSettings from "@/components/AutoGenerateSettings";
import GenerationLanguageSettings from "@/components/GenerationLanguageSettings";
import AmbientSourceControlsPanel from "@/components/AmbientSourceControlsPanel";
import AmbientTimelineSummaryStatusPanel from "@/components/AmbientTimelineSummaryStatusPanel";
import { isNative } from "@/lib/platform";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useUserSettings } from "@/hooks/useUserSettings";

// AmbientModelsPanel pulls in @pin/capacitor-ambient-ai which is
// rollup-external for the web build, so it must be loaded lazily and
// only mounted on native; the web bundle never references the bare
// specifier this way.
const AmbientModelsPanel = lazy(() => import("@/components/AmbientModelsPanel"));

type SettingsSubPage =
  | "main"
  | "subscription"
  | "preferences"
  | "notifications"
  | "ambient";

export interface AccountPanelProps {
  /** Display name shown on the profile card. Falls back to email prefix. */
  userName?: string;
  /** Single-letter avatar shown in the round chip. Falls back to first initial of userName. */
  avatarLetter?: string;
  /** Email shown on the profile card subtitle. */
  userEmail?: string;
  /** Optional sign-out handler. When provided, replaces the Edit button with Sign out. */
  onSignOut?: () => void;
  /**
   * Reserved for future re-introduction of an account-deletion entry
   * point. The Setting tab now matches the design which has no Danger
   * Zone surface; ConstellationLayout still wires a real handler so we
   * can resurrect the flow under a different surface without API churn.
   */
  onDeleteAccount?: () => Promise<void>;
}

export default function AccountPanel({
  userName = "Account",
  avatarLetter,
  userEmail,
  onSignOut,
}: AccountPanelProps = {}) {
  const initial = (avatarLetter ?? userName.trim().slice(0, 1) ?? "?").toUpperCase();
  const subtitle = userEmail ?? "Signed in";

  const [subPage, setSubPage] = useState<SettingsSubPage>("main");

  if (subPage === "subscription") {
    return <SubscriptionSubPage onBack={() => setSubPage("main")} />;
  }
  if (subPage === "preferences") {
    return <PreferencesSubPage onBack={() => setSubPage("main")} />;
  }
  if (subPage === "notifications") {
    return <NotificationsSubPage onBack={() => setSubPage("main")} />;
  }
  if (subPage === "ambient") {
    return <AmbientSubPage onBack={() => setSubPage("main")} />;
  }

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      {/* Header — mirrors MinimalistSetting from the design source. */}
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Setting</h1>
      <p className="text-xs text-muted-foreground mb-5">Subscription · Preferences · Notifications · Ambient</p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        {/* Profile card — kept on the Setting tab (design has no equivalent
            but we need a visible signed-in identity + sign-out entry). */}
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

        {/* Subscription & Billing — opens the existing plan-selection card
            below as a sub-page (preserves Stripe / billing UI). */}
        <button
          onClick={() => setSubPage("subscription")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <Sparkles size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Subscription & Billing</p>
            <p className="text-[11px] text-foreground/50 mt-0.5">Manage plan, billing, payment</p>
          </div>
          <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-md bg-[hsl(304_75%_63%/0.12)] text-[hsl(304_75%_63%)] shrink-0">
            Pro
          </span>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>

        {/* Preferences — auto-generate / dreaming / language. */}
        <button
          onClick={() => setSubPage("preferences")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <SlidersHorizontal size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Preferences</p>
            <p className="text-[11px] text-foreground/50 mt-0.5">Tone, formatting, defaults</p>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>

        {/* Push Notifications — OS permission + per-channel toggles. */}
        <button
          onClick={() => setSubPage("notifications")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <Bell size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Push Notifications</p>
            <p className="text-[11px] text-foreground/50 mt-0.5">What gets through — even during quiet hours</p>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>

        {/* Ambient — on-device perception controls (not in the design's
            MinimalistSetting but preserved here because the underlying
            functionality is real and has no other surface). */}
        <button
          onClick={() => setSubPage("ambient")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <Radio size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Ambient</p>
            <p className="text-[11px] text-foreground/50 mt-0.5">Source consents, on-device models, summaries</p>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>
      </motion.div>
    </div>
  );
}

/* ── Shared sub-page header ─────────────────────────────────────────── */

function SubPageHeader({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-2 mb-4 -ml-1.5">
      <button
        onClick={onBack}
        aria-label="Back to settings"
        className="p-1.5 rounded-full hover:bg-foreground/8 transition-colors text-foreground/50"
      >
        <ArrowLeft size={16} strokeWidth={1.5} />
      </button>
      <div className="flex-1 min-w-0">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight leading-tight">{title}</h1>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

/* ── Subscription sub-page ─────────────────────────────────────────── */

interface BillingEntry {
  date: string;
  amount: string;
  status: "Paid" | "Refunded";
  description: string;
}

const SUBSCRIPTION_BILLING_HISTORY: BillingEntry[] = [
  { date: "May 1, 2026", amount: "$99.00", status: "Paid", description: "Pro plan — monthly" },
  { date: "Apr 1, 2026", amount: "$99.00", status: "Paid", description: "Pro plan — monthly" },
  { date: "Mar 1, 2026", amount: "$99.00", status: "Paid", description: "Pro plan — monthly" },
  { date: "Feb 1, 2026", amount: "$39.00", status: "Paid", description: "Basic plan — monthly" },
];

const SUBSCRIPTION_PRO_FEATURES = [
  "6,000 credits / mo",
  "Local Llama 3 8B · Cloud Claude Sonnet",
  "Connect unlimited apps",
  "Voice + Ambient mode",
  "Priority execution",
];

/**
 * Subscription sub-page — mirrors `MinimalistSubscription` from the
 * design source. Plan / payment / billing data is presentation-only
 * mock for now; wiring to real Stripe state happens in a follow-up.
 */
function SubscriptionSubPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <SubPageHeader
        title="Subscription"
        subtitle="Plan, billing, and payment method."
        onBack={onBack}
      />

      {/* Current plan */}
      <div className="glass-card-strong p-4 mb-3">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-[hsl(304_75%_63%/0.12)] flex items-center justify-center flex-shrink-0">
            <Sparkles size={16} strokeWidth={1.8} className="text-[hsl(304_75%_63%)]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold text-foreground">Pro</span>
              <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(304_75%_63%/0.1)] text-[hsl(304_75%_63%)]">
                Active
              </span>
            </div>
            <p className="text-[11px] text-foreground/55 mt-0.5">
              $99 / mo · renews on Jun 1, 2026
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
          {SUBSCRIPTION_PRO_FEATURES.map((f) => (
            <div key={f} className="flex items-center gap-1.5">
              <Check size={11} strokeWidth={2.5} className="text-[hsl(304_75%_63%)] flex-shrink-0" />
              <span className="text-[11px] text-foreground/70 truncate">{f}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-2.5 mb-5">
        <button className="glass-card-strong p-3 text-left hover:bg-white/20 transition-colors">
          <p className="text-[10px] font-semibold text-foreground/45 uppercase tracking-[0.12em] mb-0.5">
            Switch plan
          </p>
          <p className="text-[13px] font-semibold text-foreground">Basic / Max</p>
        </button>
        <button className="glass-card-strong p-3 text-left hover:bg-white/20 transition-colors">
          <p className="text-[10px] font-semibold text-foreground/45 uppercase tracking-[0.12em] mb-0.5">
            Add credits
          </p>
          <p className="text-[13px] font-semibold text-foreground">One-time top-up</p>
        </button>
      </div>

      {/* Payment method */}
      <div className="glass-card-strong p-4 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <CreditCard size={13} strokeWidth={1.8} className="text-foreground/55" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/55">
            Payment method
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-7 rounded-md bg-foreground/85 text-background flex items-center justify-center text-[10px] font-bold tracking-wider">
              VISA
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-foreground">•••• 4242</p>
              <p className="text-[11px] text-foreground/50">Expires 09 / 27 · Default</p>
            </div>
          </div>
          <button className="text-[11px] font-semibold text-foreground border border-foreground/15 rounded-lg px-2.5 py-1 hover:bg-foreground/[0.04] transition-colors">
            Update
          </button>
        </div>
      </div>

      {/* Billing history */}
      <div className="glass-card-strong p-4 mb-3">
        <div className="flex items-center gap-2 mb-3">
          <Receipt size={13} strokeWidth={1.8} className="text-foreground/55" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/55">
            Billing history
          </span>
          <span className="text-[10px] text-foreground/40 ml-auto">{SUBSCRIPTION_BILLING_HISTORY.length} entries</span>
        </div>
        <ul className="divide-y divide-foreground/[0.06]">
          {SUBSCRIPTION_BILLING_HISTORY.map((b) => (
            <li key={b.date} className="py-2.5 flex items-center gap-3">
              <Calendar size={13} strokeWidth={1.7} className="text-foreground/40 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] font-medium text-foreground/85 truncate">
                  {b.description}
                </p>
                <p className="text-[11px] text-foreground/45">{b.date}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[13px] font-semibold text-foreground tabular-nums">{b.amount}</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-foreground/[0.06] text-foreground/55">
                  {b.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Cancel */}
      <button
        className="w-full rounded-2xl border border-[hsl(0_72%_60%/0.25)] bg-[hsl(0_72%_60%/0.04)] px-4 py-3.5 flex items-center gap-3 text-left hover:bg-[hsl(0_72%_60%/0.08)] transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-[hsl(0_72%_60%/0.10)] flex items-center justify-center flex-shrink-0">
          <AlertTriangle size={16} strokeWidth={1.8} className="text-[hsl(0_72%_50%)]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[hsl(0_72%_45%)]">Cancel subscription</p>
          <p className="text-[11px] text-foreground/50 mt-0.5">
            Keep Pro features until Jun 1, then downgrade to Basic.
          </p>
        </div>
      </button>
    </div>
  );
}

/* ── Preferences sub-page ──────────────────────────────────────────── */

function PreferencesSubPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <SubPageHeader
        title="Preferences"
        subtitle="How your AI behaves — tone, formatting, and defaults."
        onBack={onBack}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        <section className="glass-card-strong p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Dreaming</h2>
            <p className="text-[11px] text-foreground/42 mt-1">
              Review background dreaming runs, profile diffs, and candidate cards.
            </p>
          </div>
          <AutoDreamingSettings />
        </section>

        <section className="glass-card-strong p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Generation</h2>
            <p className="text-[11px] text-foreground/42 mt-1">
              Tune how cards are generated and shown to you.
            </p>
          </div>
          <AutoGenerateSettings />
          <GenerationLanguageSettings />
        </section>
      </motion.div>
    </div>
  );
}

/* ── Push Notifications sub-page ───────────────────────────────────── */

/**
 * Push Notifications sub-page — system permission is a capability,
 * `notifyNewCards` is the product-level preference.
 *
 * Web has no Capacitor push runtime, so on web the toggle is rendered
 * disabled with the design layout intact — keeps the sub-page non-empty
 * for dev previews without faking a granted state.
 */
function NotificationsSubPage({ onBack }: { onBack: () => void }) {
  const push = usePushNotifications();
  const userSettings = useUserSettings();
  const unsupported = push.permissionState === "unsupported";
  const granted = push.permissionState === "granted";
  const denied = push.permissionState === "denied";
  const promptable = push.permissionState === "prompt"
    || push.permissionState === "prompt-with-rationale";
  const notifyNewCards = userSettings.settings?.notifyNewCards ?? false;
  const isOn = granted && notifyNewCards;
  const busy = !push.ready || userSettings.loading || userSettings.saving;

  const handleToggle = async () => {
    if (unsupported || busy) return;

    if (!granted) {
      if (promptable) {
        const nextPermission = await push.requestPermission();
        if (nextPermission === "granted") {
          void userSettings.patch({ notifyNewCards: true });
        }
        return;
      }
      // Once iOS notification permission is denied/disabled, only the
      // system Settings app can re-enable it.
      window.location.href = "app-settings:";
      return;
    }

    if (!userSettings.settings) return;
    void userSettings.patch({ notifyNewCards: !notifyNewCards });
  };

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <SubPageHeader
        title="Push Notifications"
        subtitle="Control what your AI is allowed to interrupt you with."
        onBack={onBack}
      />

      <div className="space-y-3">
        <button
          type="button"
          onClick={handleToggle}
          aria-pressed={isOn}
          disabled={unsupported || busy}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors disabled:hover:bg-transparent disabled:cursor-default"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Card generation</p>
            <p className="text-[11px] text-foreground/50 mt-0.5">
              {unsupported
                ? "Available only in the iOS app."
                : denied
                  ? "Disabled in system settings — tap to open."
                  : isOn
                    ? "Notify me when your AI surfaces a new proactive card."
                    : granted
                      ? "Paused in PIN AI — tap to resume card alerts."
                      : "Tap to enable system notifications."}
            </p>
          </div>
          <span
            className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${
              isOn ? "bg-foreground" : "bg-foreground/20"
            }`}
            role="presentation"
          >
            <motion.span
              layout
              transition={{ type: "tween", duration: 0.2, ease: "easeInOut" }}
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-background shadow-sm ${
                isOn ? "left-[18px]" : "left-0.5"
              }`}
            />
          </span>
        </button>
      </div>
    </div>
  );
}

/* ── Ambient sub-page ──────────────────────────────────────────────── */

/**
 * Ambient sub-page — three real ambient-perception controls relocated
 * from the now-removed Control tab:
 *
 *   1. Source consent toggles (mic / location / motion / health / network …)
 *      → wired to pai_user_settings.ambient_source_consent via useUserSettings.
 *   2. Timeline summary status — live state of today's local LLM
 *      summarization pipeline (pending / summarized / failed windows).
 *   3. On-device models — Whisper.cpp / llama.cpp profile manager via the
 *      @pin/capacitor-ambient-ai native plugin. Native-only; web shows a
 *      "available only in iOS app" placeholder.
 */
function AmbientSubPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <SubPageHeader
        title="Ambient"
        subtitle="Control what PIN AI can observe locally, and which on-device models it uses."
        onBack={onBack}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        <AmbientSourceControlsPanel />

        <AmbientTimelineSummaryStatusPanel />

        <section className="glass-card-strong p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">On-device models</h2>
            <p className="text-[11px] text-foreground/42 mt-1 leading-relaxed">
              Manage the on-device models used for offline speech and reasoning.
            </p>
          </div>

          {isNative ? (
            <Suspense
              fallback={
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4 text-[11px] text-foreground/45">
                  Loading model manifest…
                </div>
              }
            >
              <AmbientModelsPanel />
            </Suspense>
          ) : (
            <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4 text-[12px] text-foreground/60 leading-relaxed">
              On-device models are only available inside the iOS app. Open this
              page in the native build to download, verify, or delete the
              Whisper / local LLM profiles.
            </div>
          )}

          <p className="text-[11px] text-foreground/45 leading-snug">
            Models are stored locally and never re-uploaded. If a download
            fails, the plugin automatically falls back to the secondary
            mirror.
          </p>
        </section>
      </motion.div>
    </div>
  );
}
