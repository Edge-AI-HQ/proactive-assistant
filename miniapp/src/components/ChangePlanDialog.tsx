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
  selectedPlan: string | null;
  onSelectPlan: (planId: string) => void;
  onCheckout: () => void;
  onCancel: () => void;
  busy: string;
}

const PLAN_BADGE: Record<string, string> = { pro: "Most Popular", max: "Best Value" };
const PLAN_PROMO: Record<string, string> = { basic: "2x", pro: "3x", max: "3.5x" };

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
  cancelAtPeriodEnd, currentPeriodEnd, onSelectPlan, onCheckout, onCancel, busy,
}: ChangePlanDialogProps) => {
  const [showBillingRules, setShowBillingRules] = useState(false);

  useBodyScrollLock(open);
  if (!open) return null;

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
              return (
                <button
                  key={plan.id}
                  className={`w-full rounded-2xl p-3.5 text-left transition-all btn-press relative ${
                    selected
                      ? "bg-white border-2 border-foreground shadow-md"
                      : "bg-white border border-border/20 shadow-sm hover:shadow-md"
                  }`}
                  onClick={() => onSelectPlan(plan.id)}
                >
                  {badge && (
                    <span className={`absolute -top-2.5 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-full ${
                      plan.id === "pro"
                        ? "bg-primary text-white"
                        : "bg-foreground text-background"
                    }`}>
                      {badge}
                    </span>
                  )}
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-foreground">{plan.name}</span>
                      {current && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[hsl(152_69%_65%/0.15)] font-medium" style={{ color: "hsl(152 69% 35%)" }}>Current</span>
                      )}
                    </div>
                    <span className="text-base font-extrabold text-foreground">
                      ${plan.price}<span className="text-xs font-normal text-muted-foreground">/mo</span>
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{plan.features[0]}</p>
                  <p className="text-[10px] font-medium text-primary mt-0.5">Early Access — {PLAN_PROMO[plan.id] ?? "2x"} credits included</p>
                </button>
              );
            })}
          </div>

          {cancelAtPeriodEnd && (
            <div className="rounded-xl bg-amber-50 px-3 py-2.5 text-[11px] text-amber-800 mb-3">
              Renewal canceled.{currentPeriodEnd ? ` Active until ${new Date(currentPeriodEnd).toLocaleDateString()}.` : ""}
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
            disabled={busy !== "none" || !selectedPlan}
          >
            {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
          </button>
          {currentPlanId && (
            <button
              className="w-full bg-secondary text-foreground rounded-2xl py-2.5 text-sm font-medium btn-press disabled:opacity-50 mt-2"
              onClick={onCancel}
              disabled={busy !== "none" || cancelAtPeriodEnd}
            >
              {busy === "cancel" ? "Processing..." : cancelAtPeriodEnd ? "Renewal Canceled" : "Cancel Renewal"}
            </button>
          )}
        </div>
      </div>

      <BillingRulesDialog open={showBillingRules} onClose={() => setShowBillingRules(false)} />
    </div>,
    document.body,
  );
};

export default ChangePlanDialog;
