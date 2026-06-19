/**
 * 订阅管理面板 —— 从 proactive-ai-frontend 的 AccountPanel 抽出（那边改
 * import，本文件是双端真源）：真实 Stripe 状态（/api/payment/subscription）、
 * Manage（Customer Portal）/ Cancel（cancel_at_period_end）/ 计划升级
 * （createCheckout）。SubPageHeader 是设置子页共用的返回头。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Sparkles, Check, ArrowLeft, CreditCard, Calendar, AlertTriangle, Receipt,
} from "lucide-react";
import {
  cancelCurrentSubscription,
  createCheckout,
  createTopup,
  getCurrentSubscription,
  getCustomerPortalUrl,
  getUsage,
  listPaymentHistory,
  listPaymentMethods,
  reconcileSubscription,
  type PaymentHistoryEntry,
  type PaymentMethodEntry,
  type PlanCode,
  type SubscriptionState,
  type UsageInfo,
} from "@pin-ai/core";
import { PLANS, planName, planCredits, planPerks } from "./PlanPaymentForm";
import { Text } from "../primitives/Text";

/* ── Shared sub-page header ─────────────────────────────────────────── */

export function SubPageHeader({
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
  paymentHistory: PaymentHistoryEntry[];
  primed: boolean;
} = {
  sub: null,
  usage: null,
  paymentMethods: [],
  paymentHistory: [],
  primed: false,
};

const SUBSCRIPTION_PRO_FEATURES = [
  "6,000 credits / mo",
  "Local Llama 3 8B · Cloud Claude Sonnet",
  "Connect unlimited apps",
  "Voice + Ambient mode",
  "Priority execution",
];

const RECONCILE_TIMEOUT_MS = 1500;
function formatCredits(credits: number): string {
  return Math.max(0, Math.round(credits)).toLocaleString();
}

function formatBudgetUsdFromCredits(credits: number): string {
  const dollars = Math.max(0, Math.round(credits)) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function resolvePlanAllowanceCredits(usage: UsageInfo | null): number {
  if (typeof usage?.planAllowanceCredits === "number") {
    return Math.max(0, Math.round(usage.planAllowanceCredits));
  }
  if (!usage) return 0;
  return Math.max(
    0,
    Math.round(usage.maxBudgetUsd * 100) - Math.round(usage.topupCreditsAvailable ?? 0),
  );
}

function optionalWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Subscription sub-page — fetches real Stripe-backed state from
 * /api/payment/subscription, surfaces Manage (Customer Portal) and
 * Cancel (cancel_at_period_end) actions. Billing history, card update,
 * invoice download all live inside the Stripe Customer Portal, not
 * here — we deliberately don't self-implement that surface.
 */
export function SubscriptionPanel({ onBack }: { onBack: () => void }) {
  // Initial values come from the module cache: if the user has visited
  // this page before this session, we render those values instantly and
  // refresh silently in the background. First-ever mount has primed=false
  // so loading=true triggers the cold-start spinner once.
  const [sub, setSub] = useState<SubscriptionState | null>(subscriptionPanelCache.sub);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodEntry[]>(subscriptionPanelCache.paymentMethods);
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryEntry[]>(subscriptionPanelCache.paymentHistory);
  const [usage, setUsage] = useState<UsageInfo | null>(subscriptionPanelCache.usage);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [loading, setLoading] = useState(!subscriptionPanelCache.primed);
  const [actionPending, setActionPending] = useState(false);
  const [pendingPlanCode, setPendingPlanCode] = useState<PlanCode | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [showTopup, setShowTopup] = useState(false);
  const [customTopup, setCustomTopup] = useState("");

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
      const r = await optionalWithTimeout(
        reconcileSubscription(),
        RECONCILE_TIMEOUT_MS,
      );
      // Only warn when 2+ subs are actually going to bill — a sub in
      // cancel_at_period_end will wind down on its own, not a duplicate.
      if (r && (r.activelyRenewing ?? r.totalActive ?? 0) > 1) multipleActive = true;
      const [s, pms, invs, u] = await Promise.all([
        getCurrentSubscription(),
        listPaymentMethods().catch(() => [] as PaymentMethodEntry[]),
        listPaymentHistory(12).catch(() => [] as PaymentHistoryEntry[]),
        getUsage().catch(() => null as UsageInfo | null),
      ]);
      // Write through to module cache so the next mount can render
      // instantly without re-fetching.
      setSub(s); subscriptionPanelCache.sub = s;
      setPaymentMethods(pms); subscriptionPanelCache.paymentMethods = pms;
      setPaymentHistory(invs); subscriptionPanelCache.paymentHistory = invs;
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
        const matchedPlan = PLANS.find((p) => p.id === planCode);
        const newPlanName =
          (matchedPlan ? planName(matchedPlan.id) : null)
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

  const onTopup = async (amountCents: number) => {
    if (actionPending) return;
    setActionPending(true);
    setActionToast(null);
    setError(null);
    try {
      const r = await createTopup(amountCents, {
        successUrl: `${window.location.origin}/?topup=success`,
        cancelUrl: `${window.location.origin}/?topup=cancel`,
      });
      // Stripe Checkout (mode=payment) — credits land on the
      // checkout.session.completed webhook after the user pays.
      window.location.href = r.checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "topup failed");
      setActionPending(false);  // success path navigates away, no reset needed
    }
  };

  const onCustomTopup = () => {
    const dollars = Number(customTopup);
    if (!Number.isFinite(dollars) || dollars < 5 || dollars > 1000) {
      setError("Enter an amount between $5 and $1000");
      return;
    }
    void onTopup(Math.round(dollars * 100));
  };

  const togglePlanPicker = () => {
    const next = !showPlanPicker;
    setShowPlanPicker(next);
    if (next) setShowTopup(false);
  };

  const toggleTopupPicker = () => {
    const next = !showTopup;
    setShowTopup(next);
    if (next) setShowPlanPicker(false);
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
  const currentFeatures = currentPlanInfo ? planPerks(currentPlanInfo.id) : [];
  const monthlyPlanCredits = resolvePlanAllowanceCredits(usage);
  const totalSpendCredits = Math.max(0, Math.round((usage?.spendUsd ?? 0) * 100));
  const planCreditsUsed = Math.min(totalSpendCredits, monthlyPlanCredits);
  const topupCreditsGranted = Math.max(
    0,
    Math.round(usage?.topupCreditsAvailable ?? 0),
  );
  const extraCreditsSpent = Math.max(0, totalSpendCredits - monthlyPlanCredits);
  const extraCreditsAvailable = Math.max(0, topupCreditsGranted - extraCreditsSpent);
  const planCreditsRemaining = Math.max(0, monthlyPlanCredits - planCreditsUsed);
  const totalCreditsAvailable = planCreditsRemaining + extraCreditsAvailable;
  const creditsAvailableLine = extraCreditsAvailable > 0
    ? `${formatCredits(extraCreditsAvailable)} extra credits`
    : null;
  const withCreditsAvailable = (line: string) =>
    creditsAvailableLine ? `${line} · ${creditsAvailableLine}` : line;
  const priceLine = (() => {
    if (isFree) {
      const freeBudgetLine = monthlyPlanCredits > 0
        ? `${formatBudgetUsdFromCredits(monthlyPlanCredits)} / month budget`
        : "$5 / month budget";
      return creditsAvailableLine
        ? `${freeBudgetLine} · ${creditsAvailableLine}`
        : `${freeBudgetLine} · upgrade for more`;
    }
    const head = currentPlanInfo?.price ? `$${currentPlanInfo.price} / mo` : "—";
    if (sub.cancelAtPeriodEnd && periodEnd) return withCreditsAvailable(`${head} · ends ${periodEnd}`);
    if (sub.status === "trialing" && periodEnd) return withCreditsAvailable(`${head} · trial ends ${periodEnd}`);
    if (periodEnd) return withCreditsAvailable(`${head} · renews on ${periodEnd}`);
    return withCreditsAvailable(head);
  })();
  const otherPlansLabel = (() => {
    if (isFree) return "Basic / Pro / Max";
    const others = PLANS.filter((p) => p.id !== sub?.planCode).map((p) => planName(p.id));
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
        <Text variant="label" className="block text-foreground/55 py-4">
          Loading subscription…
        </Text>
      )}

      {error && (
        <Text variant="label" className="block rounded-xl border border-[hsl(0_72%_60%/0.25)] bg-[hsl(0_72%_60%/0.04)] px-3 py-2 mb-3 text-[hsl(0_72%_45%)]">
          {error}
        </Text>
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
                  <Text variant="micro" weight="bold" className="tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(304_75%_63%/0.1)] text-[hsl(304_75%_63%)]">
                    {statusLabel}
                  </Text>
                </div>
                <Text variant="caption" className="block text-foreground/55 mt-0.5">{priceLine}</Text>
                {sub.pendingPlanCode && (
                  <Text variant="caption" weight="medium" className="block text-[hsl(292_78%_63%)] mt-0.5">
                    → Switching to{" "}
                    {(() => {
                      const pending = PLANS.find((p) => p.id === sub.pendingPlanCode);
                      return pending
                        ? planName(pending.id)
                        : sub.pendingPlanCode.charAt(0).toUpperCase() + sub.pendingPlanCode.slice(1);
                    })()}
                    {periodEnd ? ` on ${periodEnd}` : ""}
                  </Text>
                )}
              </div>
            </div>
            {currentFeatures.length > 0 && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
                {currentFeatures.map((f: string) => (
                  <div key={f} className="flex items-center gap-1.5">
                    <Check size={11} strokeWidth={2.5} className="text-[hsl(304_75%_63%)] flex-shrink-0" />
                    <Text variant="caption" className="text-foreground/70 truncate">{f}</Text>
                  </div>
                ))}
              </div>
            )}

            {/* Budget usage progress — product plan bucket + purchased top-up bucket. */}
            {usage && monthlyPlanCredits > 0 && (() => {
              const pct = (planCreditsUsed / monthlyPlanCredits) * 100;
              const clamped = Math.min(100, Math.max(0, pct));
              const creditsExhausted = totalCreditsAvailable <= 0;
              const planUsageText = `${formatCredits(planCreditsUsed)} / ${formatCredits(monthlyPlanCredits)} credits`;
              const extraCreditsText = `${formatCredits(extraCreditsAvailable)} available`;
              const barColor = creditsExhausted
                ? "hsl(0 75% 55%)"
                : pct >= 80
                  ? "hsl(40 95% 55%)"
                  : "hsl(150 70% 50%)";
              return (
                <div className={`${currentFeatures.length > 0 ? "mt-3 pt-3 border-t border-foreground/[0.06]" : "mt-2"}`}>
                  <div className="flex items-center justify-between text-caption mb-1.5">
                    <span className="text-foreground/55 uppercase tracking-[0.12em] font-semibold">
                      Plan credits
                    </span>
                    <span className="text-foreground/85 font-medium tabular-nums">
                      {planUsageText}
                      <span className="text-foreground/45 ml-1">({Math.round(pct)}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${clamped}%`, background: barColor }}
                    />
                  </div>
                  {topupCreditsGranted > 0 && (
                    <div className="mt-2 flex items-start justify-between gap-3 text-caption">
                      <div>
                        <span className="block text-foreground/55 uppercase tracking-[0.12em] font-semibold">
                          Extra credits
                        </span>
                        <Text variant="micro" className="block text-foreground/45 mt-0.5">
                          Used after plan credits
                        </Text>
                      </div>
                      <span className="text-foreground/85 font-medium tabular-nums text-right">
                        {extraCreditsText}
                      </span>
                    </div>
                  )}
                  {creditsExhausted && (
                    <Text variant="caption" className="block text-[hsl(0_72%_45%)] mt-1.5">
                      Credits exhausted — add credits or wait until {isFree ? "you upgrade your plan" : "next renewal"}.
                    </Text>
                  )}
                </div>
              );
            })()}
          </div>

          {actionToast && (
            <Text variant="label" className="block rounded-xl border border-[hsl(304_75%_63%/0.25)] bg-[hsl(304_75%_63%/0.05)] px-3 py-2 mb-3 text-foreground/75">
              {actionToast}
            </Text>
          )}

          {/* 2. Quick actions — Switch plan expands the plan picker; Add credits
              expands the one-time top-up picker below. */}
          <div className="grid grid-cols-2 gap-2.5 mb-3">
            <button
              onClick={togglePlanPicker}
              className="glass-card-strong p-3 text-left hover:bg-white/20 transition-colors"
            >
              <Text variant="micro" weight="semibold" className="block text-foreground/45 uppercase tracking-[0.12em] mb-0.5">
                Change plan
              </Text>
              <Text variant="bodySm" weight="semibold" className="block text-foreground">{showPlanPicker ? "Hide" : otherPlansLabel}</Text>
            </button>
            <button
              onClick={toggleTopupPicker}
              className="glass-card-strong p-3 text-left hover:bg-white/20 transition-colors"
            >
              <Text variant="micro" weight="semibold" className="block text-foreground/45 uppercase tracking-[0.12em] mb-0.5">
                Add credits
              </Text>
              <Text variant="bodySm" weight="semibold" className="block text-foreground">{showTopup ? "Hide" : "Buy credits"}</Text>
            </button>
          </div>

          {/* 2b. Top-up picker — one-time credit purchase via /api/payment/topup
              (Stripe Checkout mode=payment). Credits land on the
              checkout.session.completed webhook; balance updates after payment. */}
          {showTopup && (
            <div className="glass-card-strong p-3 mb-3 space-y-2.5">
              <Text variant="micro" weight="semibold" className="block text-foreground/45 uppercase tracking-[0.12em]">
                Add credits (one-time)
              </Text>
              <div className="grid grid-cols-3 gap-2">
                {[2000, 5000, 10000].map((cents) => (
                  <button
                    key={cents}
                    disabled={actionPending}
                    onClick={() => void onTopup(cents)}
                    className="glass-card-strong p-2.5 text-center hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Text variant="bodySm" weight="semibold" className="block text-foreground">${cents / 100}</Text>
                    <Text variant="micro" className="block text-foreground/55">{cents.toLocaleString()} cr</Text>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-foreground/50">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={5}
                    max={1000}
                    placeholder="Other amount"
                    value={customTopup}
                    onChange={(e) => setCustomTopup(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-white/10 py-2 pl-6 pr-3 text-sm text-foreground placeholder:text-foreground/40 focus:border-white/30 focus:outline-none"
                  />
                </div>
                <button
                  disabled={actionPending || !customTopup}
                  onClick={onCustomTopup}
                  className="glass-card-strong px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Buy
                </button>
              </div>
              <Text variant="micro" className="block text-foreground/45">
                Added on top of your monthly plan allowance. Spent after the plan
                allowance runs out; expire 12 months after purchase.
              </Text>
            </div>
          )}

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
                      <Text variant="bodySm" weight="semibold" className="text-foreground">{planName(p.id)}</Text>
                      <Text variant="label" className="text-foreground/80">${p.price}/mo</Text>
                      {isCurrent && (
                        <Text variant="micro" weight="bold" className="tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(292_78%_63%/0.12)] text-[hsl(292_78%_63%)] ml-auto">
                          Current
                        </Text>
                      )}
                      {isPending && (
                        <Text variant="micro" className="text-foreground/55 ml-auto">Loading…</Text>
                      )}
                    </div>
                    <Text variant="caption" className="block text-foreground/55">{planCredits(p.id)}</Text>
                  </button>
                );
              })}
              <Text variant="caption" className="block text-foreground/45 mt-2 px-1">
                {isFree
                  ? "Card required. Cancel anytime."
                  : "All plan changes take effect at next renewal. Cancel anytime."}
              </Text>
            </div>
          )}

          {/* 3. Payment method — real Stripe cards. Update opens Stripe Customer Portal. */}
          <div className="glass-card-strong p-4 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <CreditCard size={13} strokeWidth={1.8} className="text-foreground/55" />
              <Text variant="micro" weight="semibold" className="uppercase tracking-[0.14em] text-foreground/55">
                Payment method
              </Text>
              <button
                onClick={onManage}
                disabled={actionPending}
                className="text-micro font-semibold text-foreground/55 hover:text-foreground ml-auto disabled:opacity-50"
              >
                Update on Stripe →
              </button>
            </div>
            {paymentMethods.length === 0 ? (
              <Text variant="label" className="block text-foreground/55 py-1">
                {isFree ? "No card on file — added at checkout." : "No payment method on file."}
              </Text>
            ) : (
              <ul className="space-y-2">
                {paymentMethods.map((pm) => {
                  // Pick display shape per Stripe PaymentMethod type.
                  let chipLabel = "CARD";
                  let primary = "Payment method";
                  let secondary: string | null = null;
                  const checkoutOnly = pm.source === "checkout" || pm.isSaved === false;
                  if (pm.type === "card") {
                    chipLabel = (pm.brand ?? "card").toUpperCase().slice(0, 5);
                    primary = `•••• ${pm.last4 ?? "····"}`;
                    secondary = checkoutOnly
                      ? "Used at checkout"
                      : (
                        pm.expMonth != null && pm.expYear != null
                          ? `Expires ${String(pm.expMonth).padStart(2, "0")} / ${String(pm.expYear).slice(-2)}`
                          : null
                      );
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
                  if (checkoutOnly && !secondary) {
                    secondary = "Used at checkout";
                  }
                  return (
                    <li key={pm.id} className="flex items-center gap-3">
                      <div className="w-10 h-7 rounded-md bg-foreground/85 text-background flex items-center justify-center text-micro font-bold tracking-wider">
                        {chipLabel}
                      </div>
                      <div className="min-w-0 flex-1">
                        <Text variant="bodySm" weight="semibold" className="block text-foreground truncate">
                          {primary}
                          {pm.isDefault && (
                            <Text variant="micro" weight="bold" className="ml-2 tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-[hsl(292_78%_63%/0.12)] text-[hsl(292_78%_63%)]">
                              Default
                            </Text>
                          )}
                        </Text>
                        {secondary && (
                          <Text variant="caption" className="block text-foreground/50 truncate">{secondary}</Text>
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
              <Text variant="micro" weight="semibold" className="uppercase tracking-[0.14em] text-foreground/55">
                Billing history
              </Text>
              <button
                onClick={onManage}
                disabled={actionPending}
                className="text-micro font-semibold text-foreground/55 hover:text-foreground ml-auto disabled:opacity-50"
              >
                View all on Stripe →
              </button>
            </div>
            {paymentHistory.length === 0 ? (
              <Text variant="label" className="block text-foreground/55 py-1">No payments yet.</Text>
            ) : (
              <ul className="divide-y divide-foreground/[0.06]">
                {paymentHistory.map((inv) => {
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
                  const rowContent = (
                    <>
                      <Calendar size={13} strokeWidth={1.7} className="text-foreground/40 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <Text variant="bodySm" weight="medium" className="block text-foreground/85 truncate">
                          {inv.description}
                        </Text>
                        <Text variant="caption" className="block text-foreground/45">{dateStr}</Text>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Text variant="bodySm" weight="semibold" className="text-foreground tabular-nums">{amount}</Text>
                        <Text variant="micro" weight="medium" className="px-1.5 py-0.5 rounded-md bg-foreground/[0.06] text-foreground/55">
                          {statusLabel}
                        </Text>
                      </div>
                    </>
                  );
                  return (
                    <li key={`${inv.kind}:${inv.id}`} className="py-2.5">
                      {inv.hostedInvoiceUrl ? (
                        <a
                          href={inv.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-3 hover:bg-white/10 -mx-2 px-2 rounded-md transition-colors"
                        >
                          {rowContent}
                        </a>
                      ) : (
                        <div className="flex items-center gap-3 -mx-2 px-2 rounded-md">
                          {rowContent}
                        </div>
                      )}
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
                <Text variant="caption" className="block text-foreground/50 mt-0.5">
                  {isFree
                    ? "No active subscription to cancel"
                    : sub.cancelAtPeriodEnd && periodEnd
                      ? `Plan ends ${periodEnd}`
                      : confirmingCancel
                        ? `You'll keep ${planLabel} features until ${periodEnd ?? "period end"}`
                        : `Keep ${planLabel} features until ${periodEnd ?? "period end"}, then your plan ends.`}
                </Text>
              </div>
            </button>
            {confirmingCancel && !sub.cancelAtPeriodEnd && (
              <button
                onClick={() => setConfirmingCancel(false)}
                disabled={actionPending}
                className="px-3 rounded-2xl border border-foreground/15 bg-foreground/[0.02] text-label text-foreground/65 hover:bg-foreground/[0.06] transition-colors disabled:opacity-50"
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
