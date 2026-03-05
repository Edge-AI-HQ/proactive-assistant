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
  selectedPlan: string | null;
  onSelectPlan: (planId: string) => void;
  onCheckout: () => void;
  onCancel: () => void;
  busy: string;
}

const ChangePlanDialog = ({
  open,
  onClose,
  plans,
  currentPlanId,
  selectedPlan,
  onSelectPlan,
  onCheckout,
  onCancel,
  busy,
}: ChangePlanDialogProps) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
      <div className="glass-card rounded-t-3xl sm:rounded-2xl p-5 max-w-md w-full max-h-[85vh] overflow-y-auto animate-slide-up">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-foreground">Change Plan</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Upgrade or downgrade anytime</p>
          </div>
          <button onClick={onClose} className="text-foreground">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Billing Rules */}
        <div className="mb-4 rounded-xl bg-secondary/40 p-3.5 space-y-2">
          <p className="text-xs font-semibold text-foreground">Billing Rules</p>
          <div className="flex items-start gap-2">
            <span className="text-base leading-none mt-0.5">⬆️</span>
            <p className="text-xs text-foreground/70">
              <span className="font-medium text-foreground">Upgrade</span> takes effect immediately. You'll be charged a prorated amount for the remainder of the current billing period.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-base leading-none mt-0.5">⬇️</span>
            <p className="text-xs text-foreground/70">
              <span className="font-medium text-foreground">Downgrade</span> takes effect at the next billing cycle. Your current plan remains active until then.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-base leading-none mt-0.5">🔄</span>
            <p className="text-xs text-foreground/70">
              No refunds are issued for unused time on downgrades.
            </p>
          </div>
        </div>

        <div className="space-y-2.5 mb-4">
          {plans.map((plan) => {
            const selected = selectedPlan === plan.id;
            const current = currentPlanId === plan.id;
            return (
              <button
                key={plan.id}
                className={`w-full rounded-xl p-4 text-left transition-all btn-press ${
                  selected 
                    ? "bg-white/60 border-2 border-primary shadow-lg" 
                    : "bg-white/30 border border-white/40 hover:bg-white/40"
                }`}
                onClick={() => onSelectPlan(plan.id)}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-foreground">{plan.name}</span>
                    {current && <span className="text-xs px-2 py-0.5 rounded-full bg-pin-mint/20 text-pin-mint-text font-medium">Current</span>}
                  </div>
                  <span className="text-lg font-extrabold text-primary">
                    ${plan.price}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                  </span>
                </div>
                <div className="text-xs text-foreground/60">
                  {plan.features.slice(0, 2).join(" · ")}
                </div>
              </button>
            );
          })}
        </div>

        <div className="space-y-2.5">
          <button
            className="w-full rounded-xl bg-foreground text-background px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
            onClick={onCheckout}
            disabled={busy !== "none" || !selectedPlan}
          >
            {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
          </button>
          {currentPlanId && (
            <button
              className="w-full rounded-xl bg-secondary/60 text-foreground px-4 py-3 text-sm font-medium btn-press disabled:opacity-50"
              onClick={onCancel}
              disabled={busy !== "none"}
            >
              {busy === "cancel" ? "Processing..." : "Cancel Renewal"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChangePlanDialog;
