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
  open, onClose, plans, currentPlanId, selectedPlan,
  onSelectPlan, onCheckout, onCancel, busy,
}: ChangePlanDialogProps) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl p-5 max-w-md w-full max-h-[85vh] overflow-y-auto shadow-2xl animate-scale-in">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-foreground">Change Plan</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Upgrade or downgrade anytime</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Billing Rules */}
        <div className="mb-4 rounded-xl bg-gray-50 p-3.5 space-y-2">
          <p className="text-xs font-semibold text-foreground">Billing Rules</p>
          <div className="flex items-start gap-2">
            <span className="text-base leading-none mt-0.5">⬆️</span>
            <p className="text-xs text-foreground/70">
              <span className="font-medium text-foreground">Upgrade</span> takes effect immediately with a prorated charge.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-base leading-none mt-0.5">⬇️</span>
            <p className="text-xs text-foreground/70">
              <span className="font-medium text-foreground">Downgrade</span> takes effect at the next billing cycle. No refunds.
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
                className={`w-full rounded-xl p-4 text-left transition-all btn-press border-2 ${
                  selected ? "border-primary bg-primary/5" : "border-gray-100 bg-white hover:bg-gray-50"
                }`}
                onClick={() => onSelectPlan(plan.id)}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-foreground">{plan.name}</span>
                    {current && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Current</span>
                    )}
                  </div>
                  <span className="text-lg font-extrabold text-primary">
                    ${plan.price}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {plan.features.slice(0, 2).join(" · ")}
                </div>
              </button>
            );
          })}
        </div>

        <div className="space-y-2.5">
          <button
            className="w-full rounded-xl bg-gray-900 text-white px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
            onClick={onCheckout}
            disabled={busy !== "none" || !selectedPlan}
          >
            {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
          </button>
          {currentPlanId && (
            <button
              className="w-full rounded-xl bg-gray-100 text-gray-600 px-4 py-3 text-sm font-medium btn-press disabled:opacity-50"
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
