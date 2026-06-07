import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Sparkles, Check, Bell, SlidersHorizontal, Radio, ChevronRight, ArrowLeft,
  CreditCard, Calendar, AlertTriangle, Receipt,
} from "lucide-react";
import AutoDreamingSettings from "@/components/account/AutoDreamingSettings";
import AutoGenerateSettings from "@/components/account/AutoGenerateSettings";
import GenerationLanguageSettings from "@/components/account/GenerationLanguageSettings";
import AmbientSourceControlsPanel from "@/components/ambient/AmbientSourceControlsPanel";
import AmbientTimelineSummaryStatusPanel from "@/components/ambient/AmbientTimelineSummaryStatusPanel";
import VoiceIdentitySettings from "@/components/account/VoiceIdentitySettings";
import ProactiveSettings from "@/components/account/ProactiveSettings";
import { isNative } from "@/lib/platform";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useUserSettings } from "@/hooks/useUserSettings";
import {
  cancelCurrentSubscription, createCheckout, getCurrentSubscription,
  getCustomerPortalUrl, getUsage, listInvoices, listPaymentMethods,
  reconcileSubscription,
  type InvoiceEntry, type PaymentMethodEntry,
  type PlanCode, type SubscriptionState, type UsageInfo,
} from "@/lib/api";
import { PLANS } from "@/components/account/PlanPaymentForm";
import SwipeBackLayer from "@/components/app/SwipeBackLayer";

// AmbientModelsPanel pulls in @pin/capacitor-ambient-ai which is
// rollup-external for the web build, so it must be loaded lazily and
// only mounted on native; the web bundle never references the bare
// specifier this way.
const AmbientModelsPanel = lazy(() => import("@/components/ambient/AmbientModelsPanel"));

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
   * Zone surface; AppLayout still wires a real handler so we
   * can resurrect the flow under a different surface without API churn.
   */
  onDeleteAccount?: () => Promise<void>;
  /** Controlled current sub-page. Lifted to useAppNavigation so the global
   *  goBack() (left-edge swipe) can pop a sub-page back to "main". */
  subPage: SettingsSubPage;
  /** Setter for the controlled sub-page. */
  onSubPageChange: (p: SettingsSubPage) => void;
}

export default function AccountPanel({
  userName = "Account",
  avatarLetter,
  userEmail,
  onSignOut,
  subPage,
  onSubPageChange,
}: AccountPanelProps) {
  const initial = (avatarLetter ?? userName.trim().slice(0, 1) ?? "?").toUpperCase();
  const subtitle = userEmail ?? "Signed in";
  // subPage is controlled by AppLayout via useAppNavigation so the
  // global goBack() (left-edge swipe) can pop a sub-page back to "main".
  // sessionStorage persistence now lives in the hook.
  const setSubPage = onSubPageChange;

  if (subPage !== "main") {
    // Each sub-page keeps its own ArrowLeft button; SwipeBackLayer adds the
    // iOS-style left-edge drag that also pops back to the settings main page.
    const sub =
      subPage === "subscription" ? <SubscriptionSubPage onBack={() => setSubPage("main")} /> :
      subPage === "preferences" ? <PreferencesSubPage onBack={() => setSubPage("main")} /> :
      subPage === "notifications" ? <NotificationsSubPage onBack={() => setSubPage("main")} /> :
      <AmbientSubPage onBack={() => setSubPage("main")} />;
    return (
      <SwipeBackLayer onBack={() => setSubPage("main")} className="h-full">
        {sub}
      </SwipeBackLayer>
    );
  }

  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
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

// Module-level cache so SubscriptionSubPage renders cached data on
// re-mount (tab switches, after action) instead of flashing a spinner.
// Survives across React mounts but not across full page reloads — F5
// resets the module. Populated by refresh() and never invalidated
// (last write wins; reconcile is the silent refresh path).
const subscriptionPanelCache: {
  sub: SubscriptionState | null;
  usage: UsageInfo | null;
  paymentMethods: PaymentMethodEntry[];
  invoices: InvoiceEntry[];
  primed: boolean;
} = {
  sub: null,
  usage: null,
  paymentMethods: [],
  invoices: [],
  primed: false,
};

const SUBSCRIPTION_PRO_FEATURES = [
  "6,000 credits / mo",
  "Local Llama 3 8B · Cloud Claude Sonnet",
  "Connect unlimited apps",
  "Voice + Ambient mode",
  "Priority execution",
];

/**
 * Subscription sub-page — fetches real Stripe-backed state from
 * /api/payment/subscription, surfaces Manage (Customer Portal) and
 * Cancel (cancel_at_period_end) actions. Billing history, card update,
 * invoice download all live inside the Stripe Customer Portal, not
 * here — we deliberately don't self-implement that surface.
 */
function SubscriptionSubPage({ onBack }: { onBack: () => void }) {
  // Initial values come from the module cache: if the user has visited
  // this page before this session, we render those values instantly and
  // refresh silently in the background. First-ever mount has primed=false
  // so loading=true triggers the cold-start spinner once.
  const [sub, setSub] = useState<SubscriptionState | null>(subscriptionPanelCache.sub);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodEntry[]>(subscriptionPanelCache.paymentMethods);
  const [invoices, setInvoices] = useState<InvoiceEntry[]>(subscriptionPanelCache.invoices);
  const [usage, setUsage] = useState<UsageInfo | null>(subscriptionPanelCache.usage);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [loading, setLoading] = useState(!subscriptionPanelCache.primed);
  const [actionPending, setActionPending] = useState(false);
  const [pendingPlanCode, setPendingPlanCode] = useState<PlanCode | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlanPicker, setShowPlanPicker] = useState(false);

  const refresh = useCallback(async (silent: boolean = false) => {
    try {
      // silent=true: keep current UI visible while we refetch in the
      // background (cache-first / stale-while-revalidate). Used when the
      // module cache is already primed, or after a user action where we
      // want the action's result to drive UI not a full reload spinner.
      if (!silent) setLoading(true);
      // Stripe webhook isn't forwarded in local dev → reconcile pulls
      // canonical state from Stripe + upserts pai_subscriptions. Silent
      // failure (reconcile is a "nice to have"; getCurrentSubscription
      // is the authoritative read below).
      let multipleActive = false;
      try {
        const r = await reconcileSubscription();
        // Only warn when 2+ subs are actually going to bill — a sub in
        // cancel_at_period_end will wind down on its own, not a duplicate.
        if ((r.activelyRenewing ?? r.totalActive ?? 0) > 1) multipleActive = true;
      } catch {
        /* ignored — reconcile may error on edge cases like no customer */
      }
      const [s, pms, invs, u] = await Promise.all([
        getCurrentSubscription(),
        listPaymentMethods().catch(() => [] as PaymentMethodEntry[]),
        listInvoices(12).catch(() => [] as InvoiceEntry[]),
        getUsage().catch(() => null as UsageInfo | null),
      ]);
      // Write through to module cache so the next mount can render
      // instantly without re-fetching.
      setSub(s); subscriptionPanelCache.sub = s;
      setPaymentMethods(pms); subscriptionPanelCache.paymentMethods = pms;
      setInvoices(invs); subscriptionPanelCache.invoices = invs;
      setUsage(u); subscriptionPanelCache.usage = u;
      subscriptionPanelCache.primed = true;
      setError(null);
      if (multipleActive) {
        setActionToast(
          "Multiple actively-renewing subscriptions detected on Stripe — open Customer Portal to cancel duplicates.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // If the cache is already primed (user has visited this page during
    // this session), do a silent background refresh — no spinner. Cold
    // start (primed=false) shows the spinner exactly once per page load.
    void refresh(subscriptionPanelCache.primed);
  }, [refresh]);

  const onSubscribeOrChange = async (planCode: PlanCode) => {
    if (actionPending) return;
    setActionPending(true);
    setPendingPlanCode(planCode);
    setActionToast(null);
    setError(null);
    try {
      const r = await createCheckout(planCode, {
        successUrl: `${window.location.origin}/?checkout=success`,
        cancelUrl: `${window.location.origin}/?checkout=cancel`,
      });
      if (r.checkoutUrl) {
        // new subscription — go to Stripe Checkout for card entry
        window.location.href = r.checkoutUrl;
        return;
      }
      if (r.flow === "revoke") {
        // User clicked their current plan with a pending switch active —
        // backend cleared pending_plan_code and reset Stripe price.
        setActionToast("Scheduled switch revoked — staying on current plan");
      } else {
        // Switch (upgrade / downgrade / lateral): scheduled for next renewal,
        // no immediate charge. Plan card now shows a "→ Switching to X on
        // <date>" hint sourced from sub.pendingPlanCode.
        const newPlanName =
          PLANS.find((p) => p.id === planCode)?.name
          ?? (planCode.charAt(0).toUpperCase() + planCode.slice(1));
        setActionToast(
          `Switch scheduled — ${newPlanName} takes effect at next renewal`,
        );
      }
      setShowPlanPicker(false);  // collapse picker so user sees the new state
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "checkout failed");
    } finally {
      setActionPending(false);
      setPendingPlanCode(null);
    }
  };

  const onManage = async () => {
    setActionPending(true);
    setError(null);
    try {
      const { portalUrl } = await getCustomerPortalUrl({
        returnUrl: window.location.href,
      });
      window.open(portalUrl, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "portal failed");
    } finally {
      setActionPending(false);
    }
  };

  const performCancel = async () => {
    setConfirmingCancel(false);
    setActionPending(true);
    setError(null);
    try {
      await cancelCurrentSubscription();
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "cancel failed");
    } finally {
      setActionPending(false);
    }
  };

  // Inline two-step confirm — replaces window.confirm() which can hang in
  // Capacitor / certain WebView contexts and leave actionPending pending
  // forever. The Cancel button toggles confirmingCancel, then a second
  // tap on the same button (now "Yes, cancel") performs the cancel.
  const onCancel = () => {
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      return;
    }
    void performCancel();
  };

  const planLabel = sub?.planCode
    ? sub.planCode.charAt(0).toUpperCase() + sub.planCode.slice(1)
    : "Free";

  const periodEnd = sub?.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
      })
    : null;

  const statusLabel = (() => {
    if (!sub) return "Free";
    if (sub.planCode === "free") return "Free";
    if (sub.status === "trialing") return "Trial";
    if (sub.status === "active" && sub.cancelAtPeriodEnd) return "Canceling";
    if (sub.status === "active") return "Active";
    if (sub.status === "past_due") return "Past due";
    if (sub.status === "canceled") return "Canceled";
    if (sub.status === "inactive") return "Free";
    return sub.status;
  })();

  const isFree = !sub || sub.planCode == null || sub.planCode === "free";
  const currentPlanInfo = PLANS.find((p) => p.id === sub?.planCode);
  const currentFeatures = currentPlanInfo?.perks ?? [];
  const priceLine = (() => {
    if (isFree) return "$5 / month budget · upgrade for more";
    const head = currentPlanInfo?.price ? `$${currentPlanInfo.price} / mo` : "—";
    if (sub.cancelAtPeriodEnd && periodEnd) return `${head} · ends ${periodEnd}`;
    if (sub.status === "trialing" && periodEnd) return `${head} · trial ends ${periodEnd}`;
    if (periodEnd) return `${head} · renews on ${periodEnd}`;
    return head;
  })();
  const otherPlansLabel = (() => {
    if (isFree) return "Basic / Pro / Max";
    const others = PLANS.filter((p) => p.id !== sub?.planCode).map((p) => p.name);
    return others.length > 0 ? others.join(" / ") : "—";
  })();

  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
      <SubPageHeader
        title="Subscription"
        subtitle="Plan, billing, and payment method."
        onBack={onBack}
      />

      {loading && (
        <div className="text-[12px] text-foreground/55 py-4">
          Loading subscription…
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-[hsl(0_72%_60%/0.25)] bg-[hsl(0_72%_60%/0.04)] px-3 py-2 mb-3 text-[12px] text-[hsl(0_72%_45%)]">
          {error}
        </div>
      )}

      {!loading && sub && (
        <>
          {/* 1. Current plan — adapts to sub state. Features grid uses PLANS perks for active plan; hidden for Free. */}
          <div className="glass-card-strong p-4 mb-3">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-[hsl(304_75%_63%/0.12)] flex items-center justify-center flex-shrink-0">
                <Sparkles size={16} strokeWidth={1.8} className="text-[hsl(304_75%_63%)]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-base font-semibold text-foreground">{planLabel}</span>
                  <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(304_75%_63%/0.1)] text-[hsl(304_75%_63%)]">
                    {statusLabel}
                  </span>
                </div>
                <p className="text-[11px] text-foreground/55 mt-0.5">{priceLine}</p>
                {sub.pendingPlanCode && (
                  <p className="text-[11px] text-[hsl(292_78%_63%)] mt-0.5 font-medium">
                    → Switching to{" "}
                    {PLANS.find((p) => p.id === sub.pendingPlanCode)?.name
                      ?? (sub.pendingPlanCode.charAt(0).toUpperCase() + sub.pendingPlanCode.slice(1))}
                    {periodEnd ? ` on ${periodEnd}` : ""}
                  </p>
                )}
              </div>
            </div>
            {currentFeatures.length > 0 && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
                {currentFeatures.map((f) => (
                  <div key={f} className="flex items-center gap-1.5">
                    <Check size={11} strokeWidth={2.5} className="text-[hsl(304_75%_63%)] flex-shrink-0" />
                    <span className="text-[11px] text-foreground/70 truncate">{f}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Budget usage progress — real LiteLLM spend / max_budget */}
            {usage && usage.maxBudgetUsd > 0 && (() => {
              const pct = (usage.spendUsd / usage.maxBudgetUsd) * 100;
              const clamped = Math.min(100, Math.max(0, pct));
              const overBudget = usage.spendUsd >= usage.maxBudgetUsd;
              const barColor = overBudget
                ? "hsl(0 75% 55%)"
                : pct >= 80
                  ? "hsl(40 95% 55%)"
                  : "hsl(150 70% 50%)";
              return (
                <div className={`${currentFeatures.length > 0 ? "mt-3 pt-3 border-t border-foreground/[0.06]" : "mt-2"}`}>
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="text-foreground/55 uppercase tracking-[0.12em] font-semibold">
                      Plan usage
                    </span>
                    <span className="text-foreground/85 font-medium tabular-nums">
                      {Math.round(usage.spendUsd * 100).toLocaleString()} / {Math.round(usage.maxBudgetUsd * 100).toLocaleString()} credits
                      <span className="text-foreground/45 ml-1">({Math.round(pct)}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${clamped}%`, background: barColor }}
                    />
                  </div>
                  {overBudget && (
                    <p className="text-[11px] text-[hsl(0_72%_45%)] mt-1.5">
                      Plan usage limit reached — calls blocked until {isFree ? "you upgrade your plan" : "next renewal"}.
                    </p>
                  )}
                </div>
              );
            })()}
          </div>

          {actionToast && (
            <div className="rounded-xl border border-[hsl(304_75%_63%/0.25)] bg-[hsl(304_75%_63%/0.05)] px-3 py-2 mb-3 text-[12px] text-foreground/75">
              {actionToast}
            </div>
          )}

          {/* 2. Quick actions — Switch plan expands the picker below; Add credits is a placeholder until we wire one-time top-ups. */}
          <div className="grid grid-cols-2 gap-2.5 mb-3">
            <button
              onClick={() => setShowPlanPicker((v) => !v)}
              className="glass-card-strong p-3 text-left hover:bg-white/20 transition-colors"
            >
              <p className="text-[10px] font-semibold text-foreground/45 uppercase tracking-[0.12em] mb-0.5">
                {showPlanPicker ? "Hide options" : isFree ? "Upgrade plan" : "Switch plan"}
              </p>
              <p className="text-[13px] font-semibold text-foreground">{otherPlansLabel}</p>
            </button>
            <button
              disabled
              className="glass-card-strong p-3 text-left opacity-60 cursor-not-allowed"
            >
              <p className="text-[10px] font-semibold text-foreground/45 uppercase tracking-[0.12em] mb-0.5">
                Add credits
              </p>
              <p className="text-[13px] font-semibold text-foreground/70">Coming soon</p>
            </button>
          </div>

          {/* 2a. Plan picker — revealed when Switch plan is tapped. Wires to /api/payment/create-checkout (handles new / upgrade / downgrade). */}
          {showPlanPicker && (
            <div className="space-y-2 mb-5">
              {PLANS.map((p) => {
                const isCurrent = p.id === sub.planCode;
                const isPending = pendingPlanCode === p.id;
                return (
                  <button
                    key={p.id}
                    disabled={actionPending || isCurrent}
                    onClick={() => onSubscribeOrChange(p.id)}
                    className="w-full glass-card-strong p-4 text-left transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
                    style={isCurrent ? { borderColor: "hsla(292 78% 63% / 0.45)" } : undefined}
                  >
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-[14px] font-semibold text-foreground">{p.name}</span>
                      <span className="text-[12px] text-foreground/80">${p.price}/mo</span>
                      {isCurrent && (
                        <span className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(292_78%_63%/0.12)] text-[hsl(292_78%_63%)] ml-auto">
                          Current
                        </span>
                      )}
                      {isPending && (
                        <span className="text-[10px] text-foreground/55 ml-auto">Loading…</span>
                      )}
                    </div>
                    <p className="text-[11px] text-foreground/55">{p.credits}</p>
                  </button>
                );
              })}
              <p className="text-[11px] text-foreground/45 mt-2 px-1">
                {isFree
                  ? "Card required. Cancel anytime."
                  : "All plan changes take effect at next renewal. Cancel anytime."}
              </p>
            </div>
          )}

          {/* 3. Payment method — real Stripe cards. Update opens Stripe Customer Portal. */}
          <div className="glass-card-strong p-4 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <CreditCard size={13} strokeWidth={1.8} className="text-foreground/55" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/55">
                Payment method
              </span>
              <button
                onClick={onManage}
                disabled={actionPending}
                className="text-[10px] font-semibold text-foreground/55 hover:text-foreground ml-auto disabled:opacity-50"
              >
                Update on Stripe →
              </button>
            </div>
            {paymentMethods.length === 0 ? (
              <p className="text-[12px] text-foreground/55 py-1">
                {isFree ? "No card on file — added at checkout." : "No payment method on file."}
              </p>
            ) : (
              <ul className="space-y-2">
                {paymentMethods.map((pm) => {
                  // Pick display shape per Stripe PaymentMethod type.
                  let chipLabel = "CARD";
                  let primary = "Payment method";
                  let secondary: string | null = null;
                  if (pm.type === "card") {
                    chipLabel = (pm.brand ?? "card").toUpperCase().slice(0, 5);
                    primary = `•••• ${pm.last4 ?? "····"}`;
                    secondary = pm.expMonth != null && pm.expYear != null
                      ? `Expires ${String(pm.expMonth).padStart(2, "0")} / ${String(pm.expYear).slice(-2)}`
                      : null;
                  } else if (pm.type === "link") {
                    chipLabel = "LINK";
                    primary = "Stripe Link";
                    secondary = pm.linkEmail ?? null;
                  } else if (pm.type === "apple_pay") {
                    chipLabel = " ";
                    primary = "Apple Pay";
                  } else if (pm.type === "google_pay") {
                    chipLabel = "G PAY";
                    primary = "Google Pay";
                  } else if (pm.type === "us_bank_account") {
                    chipLabel = "BANK";
                    primary = `Bank ${pm.last4 ? "•••• " + pm.last4 : "account"}`;
                  } else {
                    chipLabel = pm.type.toUpperCase().slice(0, 5);
                    primary = pm.type;
                  }
                  return (
                    <li key={pm.id} className="flex items-center gap-3">
                      <div className="w-10 h-7 rounded-md bg-foreground/85 text-background flex items-center justify-center text-[10px] font-bold tracking-wider">
                        {chipLabel}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-foreground truncate">
                          {primary}
                          {pm.isDefault && (
                            <span className="ml-2 text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(292_78%_63%/0.12)] text-[hsl(292_78%_63%)]">
                              Default
                            </span>
                          )}
                        </p>
                        {secondary && (
                          <p className="text-[11px] text-foreground/50 truncate">{secondary}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 4. Billing history — real Stripe invoices. Each row links to hosted_invoice_url. */}
          <div className="glass-card-strong p-4 mb-3">
            <div className="flex items-center gap-2 mb-3">
              <Receipt size={13} strokeWidth={1.8} className="text-foreground/55" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/55">
                Billing history
              </span>
              <button
                onClick={onManage}
                disabled={actionPending}
                className="text-[10px] font-semibold text-foreground/55 hover:text-foreground ml-auto disabled:opacity-50"
              >
                View all on Stripe →
              </button>
            </div>
            {invoices.length === 0 ? (
              <p className="text-[12px] text-foreground/55 py-1">No payments yet.</p>
            ) : (
              <ul className="divide-y divide-foreground/[0.06]">
                {invoices.map((inv) => {
                  const dateStr = new Date(inv.createdAt * 1000).toLocaleDateString("en-US", {
                    year: "numeric", month: "short", day: "numeric",
                  });
                  const amount = `$${(inv.amountPaidCents / 100).toFixed(2)}`;
                  const statusLabel = inv.status === "paid" ? "Paid"
                    : inv.status === "open" ? "Open"
                    : inv.status === "draft" ? "Draft"
                    : inv.status === "void" ? "Void"
                    : inv.status === "uncollectible" ? "Failed"
                    : inv.status;
                  return (
                    <li key={inv.id} className="py-2.5">
                      <a
                        href={inv.hostedInvoiceUrl ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 hover:bg-white/10 -mx-2 px-2 rounded-md transition-colors"
                      >
                        <Calendar size={13} strokeWidth={1.7} className="text-foreground/40 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[12.5px] font-medium text-foreground/85 truncate">
                            {inv.description}
                          </p>
                          <p className="text-[11px] text-foreground/45">{dateStr}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[13px] font-semibold text-foreground tabular-nums">{amount}</span>
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-foreground/[0.06] text-foreground/55">
                            {statusLabel}
                          </span>
                        </div>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 5. Cancel — wired to /api/payment/cancel (cancel_at_period_end).
              Two-tap inline confirm (avoids window.confirm hangs in some
              webview contexts). Disabled when Free or already scheduled. */}
          <div className="flex items-stretch gap-2">
            <button
              onClick={onCancel}
              disabled={actionPending || isFree || sub.cancelAtPeriodEnd}
              className="flex-1 rounded-2xl border border-[hsl(0_72%_60%/0.25)] bg-[hsl(0_72%_60%/0.04)] px-4 py-3.5 flex items-center gap-3 text-left hover:bg-[hsl(0_72%_60%/0.08)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="w-10 h-10 rounded-xl bg-[hsl(0_72%_60%/0.10)] flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={16} strokeWidth={1.8} className="text-[hsl(0_72%_50%)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[hsl(0_72%_45%)]">
                  {sub.cancelAtPeriodEnd
                    ? "Cancellation scheduled"
                    : confirmingCancel
                      ? "Tap again to confirm"
                      : "Cancel subscription"}
                </p>
                <p className="text-[11px] text-foreground/50 mt-0.5">
                  {isFree
                    ? "No active subscription to cancel"
                    : sub.cancelAtPeriodEnd && periodEnd
                      ? `Plan ends ${periodEnd}`
                      : confirmingCancel
                        ? `You'll keep ${planLabel} features until ${periodEnd ?? "period end"}`
                        : `Keep ${planLabel} features until ${periodEnd ?? "period end"}, then your plan ends.`}
                </p>
              </div>
            </button>
            {confirmingCancel && !sub.cancelAtPeriodEnd && (
              <button
                onClick={() => setConfirmingCancel(false)}
                disabled={actionPending}
                className="px-3 rounded-2xl border border-foreground/15 bg-foreground/[0.02] text-[12px] text-foreground/65 hover:bg-foreground/[0.06] transition-colors disabled:opacity-50"
              >
                Keep it
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Preferences sub-page ──────────────────────────────────────────── */

function PreferencesSubPage({ onBack }: { onBack: () => void }) {
  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
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
            <h2 className="text-sm font-semibold text-foreground">Proactive</h2>
            <p className="text-[11px] text-foreground/42 mt-1">
              How often your Proactive AI checks in on you.
            </p>
          </div>
          <ProactiveSettings />
        </section>

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
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
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
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
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

        <VoiceIdentitySettings />

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
