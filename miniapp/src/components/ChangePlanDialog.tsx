import { useState } from "react";
import { createPortal } from "react-dom";
import useBodyScrollLock from "./useBodyScrollLock";

interface Plan {
  id: string;
  name: string;
  price: string;
  features: string[];
}

interface ChangePlanDialogProps {
  open: boolean;
  onClose: () => void;
  plans: Plan[];
  currentPlanId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  downgradeLockUntil: string | null;
  pendingPlanId: string | null;
  selectedPlan: string | null;
  onSelectPlan: (planId: string) => void;
  onCheckout: () => void;
  onCancel: () => void;
  onResume: () => void;
  busy: string;
}

const PLAN_BADGE: Record<string, string> = { pro: "Most Popular", max: "Best Value" };
const PLAN_PROMO: Record<string, { original: string; actual: string; multiplier: string }> = {
  basic: { original: "1,600", actual: "3,200", multiplier: "2x" },
  pro: { original: "4,100", actual: "12,800", multiplier: "3x" },
  max: { original: "8,200", actual: "28,800", multiplier: "3.5x" },
};

const BillingRulesDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        className="relative bg-background max-w-[340px] w-full rounded-3xl p-0 overflow-hidden shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 w-7 h-7 flex items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary text-foreground/60 hover:text-foreground transition-all z-10"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>

        <div className="px-5 pt-5 pb-0">
          <h3 className="text-lg font-bold text-foreground">Billing Rules</h3>
          <p className="text-xs text-muted-foreground mt-0.5">How plan changes work</p>
        </div>

        <div className="px-5 pb-5 pt-3 space-y-3">
          <div className="flex items-start gap-2.5">
            <svg className="w-4 h-4 text-primary shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            <div>
              <p className="text-xs font-medium text-foreground">Upgrade</p>
              <p className="text-[11px] text-foreground/70">Takes effect immediately. You'll be charged the price difference for the remaining period.</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <svg className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            <div>
              <p className="text-xs font-medium text-foreground">Downgrade</p>
              <p className="text-[11px] text-foreground/70">Takes effect at the start of the next billing cycle.</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <svg className="w-4 h-4 text-muted-foreground/60 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <div>
              <p className="text-xs font-medium text-foreground">Lock period</p>
              <p className="text-[11px] text-foreground/70">After an upgrade, downgrade is locked until this billing cycle ends.</p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const ChangePlanDialog = ({
  open, onClose, plans, currentPlanId, selectedPlan,
  cancelAtPeriodEnd, currentPeriodEnd, downgradeLockUntil, pendingPlanId, onSelectPlan, onCheckout, onCancel, onResume, busy,
}: ChangePlanDialogProps) => {
  const [showBillingRules, setShowBillingRules] = useState(false);

  useBodyScrollLock(open);
  if (!open) return null;

  // Check if downgrade is locked
  const isDowngradeLocked = downgradeLockUntil && new Date(downgradeLockUntil) > new Date();
  
  // Get current plan price for comparison
  const currentPlan = plans.find((p) => p.id === currentPlanId);
  const currentPrice = currentPlan ? parseFloat(currentPlan.price) : 0;
  const pendingPlanName = plans.find((p) => p.id === pendingPlanId)?.name ?? pendingPlanId;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        className="relative bg-background max-w-[340px] w-full rounded-3xl p-0 overflow-hidden shadow-lg max-h-[65vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 w-7 h-7 flex items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary text-foreground/60 hover:text-foreground transition-all z-10"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>

        <div className="px-5 pt-5 pb-0 shrink-0">
          <h3 className="text-lg font-bold text-foreground">Change Plan</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Select a new plan for your agent</p>
        </div>

        <div className="px-5 pb-4 pt-3 overflow-y-scroll overscroll-contain flex-1">
          <div className="space-y-3 mb-3">
            {plans.map((plan) => {
              const selected = selectedPlan === plan.id;
              const current = currentPlanId === plan.id;
              const badge = PLAN_BADGE[plan.id];
              const planPrice = parseFloat(plan.price);
              const isDowngrade = planPrice < currentPrice;
              const isLocked = isDowngradeLocked && isDowngrade;
              const isDowngradeBlockedByCancel = cancelAtPeriodEnd && isDowngrade;
              const isDisabled = isLocked || isDowngradeBlockedByCancel || current;
              const isMutedDisabled = isLocked || isDowngradeBlockedByCancel;
              
              return (
                <button
                  key={plan.id}
                  className={`w-full rounded-2xl p-3.5 text-left transition-all relative ${
                    isMutedDisabled
                      ? "bg-secondary/30 border border-border/10 cursor-not-allowed opacity-60"
                      : current
                        ? "bg-secondary/30 border-2 border-foreground/30 cursor-not-allowed"
                      : selected
                        ? "bg-white border-2 border-foreground shadow-md btn-press"
                        : "bg-white border border-border/20 shadow-sm hover:shadow-md btn-press"
                  }`}
                  onClick={() => !isDisabled && onSelectPlan(plan.id)}
                  disabled={isDisabled}
                >
                  {badge && !isLocked && (
                    <span className={`absolute -top-2.5 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-full ${
                      plan.id === "pro"
                        ? "bg-primary text-white"
                        : "bg-foreground text-background"
                    }`}>
                      {badge}
                    </span>
                  )}
                  {isLocked && (
                    <span className="absolute -top-2.5 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-full bg-muted-foreground/20 text-muted-foreground flex items-center gap-1">
                      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      Locked
                    </span>
                  )}
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-sm font-bold ${isLocked || current ? "text-muted-foreground" : "text-foreground"}`}>{plan.name}</span>
                      {current && (
                        <span
                          className="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-[hsl(152_69%_65%/0.15)] font-medium"
                          style={{
                            color: "hsl(152 69% 35%)",
                            animation: "current-badge-breathe 1.8s ease-in-out infinite",
                          }}
                        >
                          Current
                        </span>
                      )}
                    </div>
                    <span className={`text-base font-extrabold ${isLocked || current ? "text-muted-foreground" : "text-foreground"}`}>
                      ${plan.price}<span className="text-xs font-normal text-muted-foreground">/mo</span>
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{plan.features[0]}</p>
                  <p className={`text-[11px] font-medium mt-0.5 ${isLocked || current ? "text-muted-foreground" : "text-primary"}`}>
                    <span className="line-through text-muted-foreground text-[10px]">{PLAN_PROMO[plan.id]?.original ?? "—"}</span>
                    {" "}
                    <span className="font-bold">{PLAN_PROMO[plan.id]?.actual ?? "—"} credits</span>
                    {" "}
                    <span className="text-[9px] text-primary/70">{PLAN_PROMO[plan.id]?.multiplier ?? ""}</span>
                  </p>
                </button>
              );
            })}
          </div>

          {cancelAtPeriodEnd && (
            <div className="rounded-xl bg-amber-50 px-3 py-2.5 text-[11px] text-amber-800 mb-3">
              Renewal canceled.{currentPeriodEnd ? ` Active until ${new Date(currentPeriodEnd).toLocaleDateString()}.` : ""}
            </div>
          )}

          {isDowngradeLocked && !cancelAtPeriodEnd && (
            <div className="rounded-xl bg-blue-50 px-3 py-2.5 text-[11px] text-blue-800 mb-3 flex items-start gap-2">
              <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>
                Downgrade locked until {downgradeLockUntil ? new Date(downgradeLockUntil).toLocaleDateString() : "current period ends"}. You can downgrade after this billing cycle.
              </span>
            </div>
          )}

          {pendingPlanId && currentPeriodEnd && (
            <div className="rounded-xl bg-emerald-50 px-3 py-2.5 text-[11px] text-emerald-800 mb-3">
              Downgrade to {pendingPlanName} is scheduled for next billing cycle ({new Date(currentPeriodEnd).toLocaleDateString()}).
            </div>
          )}

          {cancelAtPeriodEnd && (
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-[11px] text-slate-700 mb-3">
              Downgrade is unavailable while renewal is canceled. Resume renewal first.
            </div>
          )}

          <div className="flex items-center justify-center gap-1 mb-3">
            <p className="text-[10px] text-muted-foreground">
              Limited-time offer for early subscribers.
            </p>
            <button
              onClick={() => setShowBillingRules(true)}
              className="w-4 h-4 flex items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary text-muted-foreground hover:text-foreground transition-all shrink-0"
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
              </svg>
            </button>
          </div>

          <button
            className="w-full bg-foreground text-background rounded-2xl py-3 text-sm font-semibold btn-press shadow-md disabled:opacity-50"
            onClick={onCheckout}
            disabled={busy !== "none" || !selectedPlan || selectedPlan === currentPlanId}
          >
            {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
          </button>
          {currentPlanId && (
            <button
              className="w-full bg-secondary text-foreground rounded-2xl py-2.5 text-sm font-medium btn-press disabled:opacity-50 mt-2"
              onClick={cancelAtPeriodEnd ? onResume : onCancel}
              disabled={busy !== "none"}
            >
              {busy === "cancel" || busy === "resume" ? "Processing..." : cancelAtPeriodEnd ? "Resume Renewal" : "Cancel Renewal"}
            </button>
          )}
        </div>
      </div>

      <BillingRulesDialog open={showBillingRules} onClose={() => setShowBillingRules(false)} />
      <style>{`
        @keyframes current-badge-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.12); }
        }
      `}</style>
    </div>,
    document.body,
  );
};

export default ChangePlanDialog;
