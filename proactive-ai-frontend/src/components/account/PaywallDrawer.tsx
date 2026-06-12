import { useState } from "react";
import { Lock as LockIcon } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { PlanPaymentForm, PLANS, type PlanId, type PayMethod, type CardInfo } from "@/components/account/PlanPaymentForm";
import { createCheckout } from "@pin-ai/core";
import type { Intent } from "@/components/now/card-model";

interface PaywallDrawerProps {
  /** The locked card that triggered the paywall; null keeps the drawer
   *  closed. Owned by the parent because handleExecute opens it. */
  card: Intent | null;
  onClose: () => void;
}

/**
 * Paywall dialog — locked tasks require Pro to approve. Bottom-sheet with a
 * plan picker + payment method; Subscribe kicks off Stripe checkout. Plan /
 * pay / card-info / pending / error state is self-contained here (it never
 * leaves the drawer); only the open trigger (`card`) is owned by the parent.
 */
export default function PaywallDrawer({ card, onClose }: PaywallDrawerProps) {
  const [paywallPlan, setPaywallPlan] = useState<PlanId>("pro");
  const [paywallPay, setPaywallPay] = useState<PayMethod | null>("apple");
  const [paywallCard_, setPaywallCardInfo] = useState<CardInfo>({ number: "", expiry: "", cvc: "" });
  const [paywallPending, setPaywallPending] = useState(false);
  const [paywallError, setPaywallError] = useState<string | null>(null);

  return (
    <Drawer open={!!card} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent
        className="max-h-[88vh] border-t-0 !bg-transparent"
        style={{
          background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.55) 0%, hsla(0, 0%, 100%, 0.78) 100%)",
          backdropFilter: "blur(40px) saturate(1.5)",
          WebkitBackdropFilter: "blur(40px) saturate(1.5)",
          border: "1px solid hsla(0, 0%, 100%, 0.4)",
          borderBottom: "none",
          borderRadius: "1.5rem 1.5rem 0 0",
        }}
        overlayClassName="!bg-foreground/10 backdrop-blur-[2px]"
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>Choose your plan</DrawerTitle>
          <DrawerDescription>Choose a plan and payment method to approve this task</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col" style={{ maxHeight: "84vh" }}>
          <div className="px-5 pt-3 pb-24 overflow-y-auto flex-1">
            <div className="text-center mb-3">
              <div className="mx-auto w-11 h-11 rounded-2xl flex items-center justify-center mb-3"
                style={{ background: "linear-gradient(135deg, hsl(292,78%,63%) 0%, hsl(330,80%,65%) 100%)" }}>
                <LockIcon size={18} strokeWidth={2.5} className="text-white" />
              </div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-foreground/50 mb-1.5">
                Subscription required
              </p>
              <h3 className="text-display text-[19px] leading-tight text-foreground font-semibold max-w-[20rem] mx-auto">
                Pick a plan to approve “{card?.title}”
              </h3>
            </div>

            <PlanPaymentForm
              plan={paywallPlan} setPlan={setPaywallPlan}
              payMethod={paywallPay} setPayMethod={setPaywallPay}
              cardInfo={paywallCard_} setCardInfo={setPaywallCardInfo}
            />
          </div>

          <div
            className="flex items-center gap-2 px-5 py-3 border-t border-foreground/5"
            style={{ background: "hsl(var(--background))" }}
          >
            <button
              onClick={onClose}
              className="px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
            >
              Not now
            </button>
            <button
              disabled={paywallPending}
              onClick={async () => {
                setPaywallPending(true);
                setPaywallError(null);
                try {
                  const { checkoutUrl } = await createCheckout(paywallPlan, {
                    successUrl: `${window.location.origin}/?checkout=success`,
                    cancelUrl: `${window.location.origin}/?checkout=cancel`,
                  });
                  if (checkoutUrl) {
                    window.location.href = checkoutUrl;
                  } else {
                    // upgrade/downgrade applied in place — close drawer
                    onClose();
                  }
                } catch (e) {
                  setPaywallError(
                    e instanceof Error ? e.message : "checkout failed",
                  );
                } finally {
                  setPaywallPending(false);
                }
              }}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl text-background text-[13px] font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg, hsl(292,78%,63%) 0%, hsl(330,80%,65%) 100%)" }}
            >
              {paywallPending
                ? "Loading…"
                : `Subscribe · $${PLANS.find((p) => p.id === paywallPlan)?.price}/mo`}
            </button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
