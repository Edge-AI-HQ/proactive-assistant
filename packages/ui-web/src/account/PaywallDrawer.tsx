import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Lock as LockIcon, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "../ui/drawer";
import { PlanPaymentForm, PLANS, type PlanId, type PayMethod, type CardInfo } from "./PlanPaymentForm";
import { createCheckout } from "@pin-ai/core";
import type { Intent } from "../now/card-model";
import { Text } from "../primitives/Text";
import { useMediaQuery } from "../lib/use-media-query";

const ACCENT = "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330,80%,65%) 100%)";

interface PaywallDrawerProps {
  /** The locked card that triggered the paywall; null keeps it closed. Owned by
   *  the parent because handleExecute opens it. */
  card: Intent | null;
  onClose: () => void;
}

/**
 * Paywall — locked tasks require Pro to approve. Responsive following the shadcn
 * pattern documented in use-media-query: a bottom-sheet Drawer on narrow
 * screens, a centered two-column glass card on wide ones. Plan / pay / card-info
 * / pending / error state is self-contained; only the open trigger (`card`) is
 * owned by the parent. Subscribe kicks off Stripe checkout.
 *
 * "Out of Credits" framing + the wide desktop card are ported from the zebra
 * design prototype's PaywallOverlay (Edge-AI-HQ/proactive-pin-ai-c7be7ecc). The
 * Capacitor app (always narrow) renders the Drawer; the wide card lights up once
 * apps/web wires a locked-card trigger.
 */
export default function PaywallDrawer({ card, onClose }: PaywallDrawerProps) {
  const { t } = useTranslation(["account", "common"]);
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [plan, setPlan] = useState<PlanId>("pro");
  const [payMethod, setPayMethod] = useState<PayMethod | null>("apple");
  const [cardInfo, setCardInfo] = useState<CardInfo>({ number: "", expiry: "", cvc: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const price = PLANS.find((p) => p.id === plan)?.price;

  const subscribe = async () => {
    setPending(true);
    setError(null);
    try {
      const { checkoutUrl } = await createCheckout(plan, {
        successUrl: `${window.location.origin}/?checkout=success`,
        cancelUrl: `${window.location.origin}/?checkout=cancel`,
      });
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      } else {
        // upgrade/downgrade applied in place — close
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("paywall.checkoutFailed"));
    } finally {
      setPending(false);
    }
  };

  const form = (
    <PlanPaymentForm
      plan={plan} setPlan={setPlan}
      payMethod={payMethod} setPayMethod={setPayMethod}
      cardInfo={cardInfo} setCardInfo={setCardInfo}
    />
  );

  const errorRow = error ? (
    <Text variant="label" className="block text-center text-rose-500 px-5 pb-1">
      {error}
    </Text>
  ) : null;

  const notNowBtn = (
    <button
      onClick={onClose}
      className="px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-bodySm font-medium text-foreground/55"
    >
      {t("paywall.notNow")}
    </button>
  );

  // ── Wide screens: centered two-column glass card ──
  if (isWide) {
    return (
      <AnimatePresence>
        {card && (
          <motion.div
            key="paywall-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="fixed inset-0 z-[80]"
          >
            {/* Transparent mask — the app stays visible through the frost */}
            <div
              className="absolute inset-0"
              style={{
                background: "hsla(230 25% 12% / 0.30)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
              onClick={onClose}
              aria-hidden
            />
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              role="dialog"
              aria-modal="true"
              className="absolute inset-0 flex items-center justify-center p-8"
            >
              <div
                className="w-full max-w-[980px] grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] rounded-3xl overflow-hidden"
                style={{
                  background: "hsla(0, 0%, 100%, 0.50)",
                  border: "1px solid hsla(0, 0%, 100%, 0.55)",
                  backdropFilter: "blur(48px) saturate(1.6)",
                  WebkitBackdropFilter: "blur(48px) saturate(1.6)",
                  boxShadow: "0 30px 80px hsla(230 25% 12% / 0.15), inset 0 1px 0 hsla(0, 0%, 100%, 0.45)",
                }}
              >
                {/* Left — value proposition */}
                <div
                  className="p-10 flex flex-col justify-between min-h-[520px]"
                  style={{
                    background:
                      "linear-gradient(155deg, hsla(292 78% 63% / 0.14) 0%, hsla(320 75% 60% / 0.06) 60%, hsla(200 60% 60% / 0.10) 100%)",
                    borderRight: "1px solid hsla(0, 0%, 100%, 0.40)",
                  }}
                >
                  <div>
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5" style={{ background: ACCENT }}>
                      <LockIcon size={20} strokeWidth={2.4} className="text-white" />
                    </div>
                    <Text variant="micro" weight="bold" className="block uppercase tracking-[0.22em] text-foreground/50 mb-2">
                      {t("paywall.subscriptionRequired")}
                    </Text>
                    <h1 className="text-display text-title leading-[1.15] tracking-tight text-foreground font-semibold">
                      {t("paywall.outOfCredits")}
                    </h1>
                    <Text variant="bodySm" className="block text-foreground/60 mt-4 leading-relaxed max-w-[28rem]">
                      {t("paywall.outOfCreditsBody")}
                    </Text>
                  </div>

                  <ul className="mt-8 space-y-2.5">
                    {[
                      t("paywall.feature1"),
                      t("paywall.feature2"),
                      t("paywall.feature3"),
                      t("paywall.feature4"),
                    ].map((line) => (
                      <li key={line} className="flex items-start gap-2.5 text-bodySm text-foreground/75">
                        <Sparkles size={14} className="mt-0.5 text-primary shrink-0" strokeWidth={2.2} />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Right — plan picker + actions */}
                <div className="flex flex-col max-h-[88vh]">
                  <div className="flex-1 overflow-y-auto p-8">{form}</div>
                  {errorRow}
                  <div
                    className="shrink-0 flex items-center gap-3 px-8 py-5"
                    style={{
                      borderTop: "1px solid hsla(0, 0%, 100%, 0.40)",
                      background: "hsla(0, 0%, 100%, 0.35)",
                      backdropFilter: "blur(12px)",
                      WebkitBackdropFilter: "blur(12px)",
                    }}
                  >
                    {notNowBtn}
                    <button
                      disabled={pending}
                      onClick={subscribe}
                      className="flex-1 flex items-center justify-center gap-1.5 px-5 py-3 rounded-xl text-background text-bodySm font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ background: ACCENT }}
                    >
                      {pending ? t("common:status.loading") : t("paywall.startTrial", { price })}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  // ── Narrow screens: bottom-sheet Drawer ──
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
          <DrawerTitle>{t("paywall.outOfCredits")}</DrawerTitle>
          <DrawerDescription>{t("paywall.drawerDescription")}</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col" style={{ maxHeight: "84vh" }}>
          <div className="px-5 pt-3 pb-24 overflow-y-auto flex-1">
            <div className="text-center mb-3">
              <div className="mx-auto w-11 h-11 rounded-2xl flex items-center justify-center mb-3" style={{ background: ACCENT }}>
                <LockIcon size={18} strokeWidth={2.5} className="text-white" />
              </div>
              <Text variant="micro" weight="bold" className="block uppercase tracking-[0.2em] text-foreground/50 mb-1.5">
                {t("paywall.subscriptionRequired")}
              </Text>
              <h3 className="text-display text-heading leading-tight text-foreground font-semibold max-w-[20rem] mx-auto">
                {t("paywall.outOfCredits")}
              </h3>
            </div>

            {form}
          </div>

          {errorRow}
          <div
            className="flex items-center gap-2 px-5 py-3 border-t border-foreground/5"
            style={{ background: "hsl(var(--background))" }}
          >
            {notNowBtn}
            <button
              disabled={pending}
              onClick={subscribe}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl text-background text-bodySm font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: ACCENT }}
            >
              {pending ? t("common:status.loading") : t("paywall.subscribe", { price })}
            </button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
