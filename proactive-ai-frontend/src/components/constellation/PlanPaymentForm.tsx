import { motion, AnimatePresence } from "framer-motion";
import {
  Check, Apple, CreditCard, SkipForward, Zap, Crown, Star,
  type LucideIcon,
} from "lucide-react";

export type PlanId = "basic" | "pro" | "max";
export type PayMethod = "apple" | "card" | "skip";
export interface CardInfo { number: string; expiry: string; cvc: string }

interface Plan {
  id: PlanId;
  name: string;
  price: number;
  credits: string;
  localModel: string;
  cloudModel: string;
  perks: string[];
  icon: LucideIcon;
  highlight?: boolean;
}

// Display credits per plan. Numbers match pai_billing_plans.monthly_refresh_credits
// (100 credits = $1 USD LiteLLM budget). Updated 2026-05-24 to align with DB.
export const PLANS: Plan[] = [
  { id: "basic", name: "Basic", price: 39, credits: "3,200 credits / mo",
    localModel: "Gemma 2B", cloudModel: "Gemini Flash",
    perks: ["Daily card feed", "Connect 3 apps", "Email + Calendar"],
    icon: Star },
  { id: "pro",   name: "Pro",   price: 99, credits: "12,800 credits / mo",
    localModel: "Llama 3 8B", cloudModel: "Claude Sonnet",
    perks: ["Everything in Basic", "Connect unlimited apps", "Voice + Ambient mode", "Priority execution"],
    icon: Zap, highlight: true },
  { id: "max",   name: "Max",   price: 199, credits: "28,800 credits / mo",
    localModel: "Llama 3 70B", cloudModel: "Claude Opus / GPT-5",
    perks: ["Everything in Pro", "Custom personas", "Team sharing", "Early access models"],
    icon: Crown },
];

export function isPayValid(payMethod: PayMethod | null, cardInfo: CardInfo) {
  if (!payMethod) return false;
  if (payMethod === "apple" || payMethod === "skip") return true;
  return (
    cardInfo.number.replace(/\s/g, "").length === 16 &&
    cardInfo.expiry.replace(/\D/g, "").length === 4 &&
    cardInfo.cvc.length >= 3
  );
}

export function PlanPaymentForm({
  plan, setPlan, payMethod, setPayMethod, cardInfo, setCardInfo,
  showHero = true,
  allowSkip = true,
}: {
  plan: PlanId; setPlan: (p: PlanId) => void;
  payMethod: PayMethod | null; setPayMethod: (m: PayMethod) => void;
  cardInfo: CardInfo; setCardInfo: (c: CardInfo) => void;
  showHero?: boolean;
  allowSkip?: boolean;
}) {
  return (
    <div>
      {showHero && (
        <div className="text-center px-2 pt-1 pb-4 mb-2">
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-foreground/45 mb-3">
            Free for 7 days
          </div>
          <h2 className="text-display text-2xl leading-tight tracking-tight text-foreground">
            Seven days,{" "}
            <span className="italic font-light text-foreground/55">on us.</span>
          </h2>
          <div className="mx-auto mt-3 h-px w-10 bg-foreground/15" />
          <p className="text-[12.5px] text-foreground/55 mt-3 max-w-[18rem] mx-auto leading-relaxed">
            Full access to everything. No charge until day&nbsp;8 — cancel anytime.
          </p>
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wider text-foreground/45 font-semibold mb-2 px-1">
        Then continue with
      </div>

      <div className="space-y-2.5">
        {PLANS.map((p) => {
          const Icon = p.icon;
          const isSel = plan === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setPlan(p.id)}
              className="w-full text-left p-4 rounded-2xl transition-all duration-300 relative overflow-hidden"
              style={{
                background: isSel
                  ? "linear-gradient(135deg, hsla(292 78% 63% / 0.12), hsla(320 75% 60% / 0.05))"
                  : "hsla(0,0%,100%,0.6)",
                border: `1px solid ${isSel ? "hsl(292 78% 63%)" : "hsla(0,0%,100%,0.6)"}`,
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow: isSel ? "0 8px 24px hsla(292 78% 63% / 0.2)" : "0 2px 10px hsla(280 20% 60% / 0.06)",
              }}
            >
              {p.highlight && (
                <span
                  className="absolute top-3 right-3 text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider"
                  style={{ background: "hsl(292 78% 63%)", color: "white" }}
                >
                  Most popular
                </span>
              )}
              <div className="flex items-start gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{
                    background: isSel ? "hsla(292 78% 63% / 0.18)" : "hsla(220 15% 90% / 0.6)",
                    color: isSel ? "hsl(292 78% 63%)" : "hsl(220 10% 50%)",
                  }}
                >
                  <Icon size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[15px] font-bold text-foreground">{p.name}</span>
                    <span className="text-[13px] font-semibold text-foreground">${p.price}</span>
                    <span className="text-[11px] text-foreground/50">/mo</span>
                  </div>
                  <div className="text-[11.5px] text-foreground/60 mt-0.5">{p.credits}</div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    <ModelChip label={`Local · ${p.localModel}`} />
                    <ModelChip label={`Cloud · ${p.cloudModel}`} />
                  </div>

                  {isSel && (
                    <motion.ul
                      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                      className="mt-3 space-y-1 overflow-hidden"
                    >
                      {p.perks.map((perk) => (
                        <li key={perk} className="flex items-center gap-1.5 text-[12px] text-foreground/75">
                          <Check size={12} className="text-primary shrink-0" strokeWidth={3} />
                          {perk}
                        </li>
                      ))}
                    </motion.ul>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <div className="text-[10.5px] text-foreground/45 mb-2 px-1">
          {allowSkip
            ? "Add a payment method to start your free trial. You won't be charged until day 8."
            : "Choose how to pay. You'll be charged today."}
        </div>
        <div className="space-y-2">
          <PayButton active={payMethod === "apple"} onClick={() => setPayMethod("apple")}
            icon={<Apple size={18} />} label="Apple Pay" sub="Recommended · one tap" />
          <PayButton active={payMethod === "card"} onClick={() => setPayMethod("card")}
            icon={<CreditCard size={18} />} label="Credit or debit card" sub="Visa · Mastercard · Amex" />
          {allowSkip && (
            <PayButton active={payMethod === "skip"} onClick={() => setPayMethod("skip")}
              icon={<SkipForward size={18} />} label="Skip payment for now" sub="Still 7 days free · add later" />
          )}
        </div>

        <AnimatePresence initial={false}>
          {payMethod === "card" && (
            <motion.div
              key="cardform"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <div
                className="mt-2.5 p-3 rounded-xl space-y-2"
                style={{
                  background: "hsla(0,0%,100%,0.55)",
                  border: "1px solid hsla(220 15% 70% / 0.25)",
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                }}
              >
                <input
                  inputMode="numeric" autoComplete="cc-number" maxLength={19}
                  placeholder="Card number" value={cardInfo.number}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 16);
                    const formatted = digits.replace(/(.{4})/g, "$1 ").trim();
                    setCardInfo({ ...cardInfo, number: formatted });
                  }}
                  className="w-full bg-transparent text-[13px] text-foreground placeholder:text-foreground/40 px-3 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-foreground/20"
                  style={{ border: "1px solid hsla(220 15% 70% / 0.25)" }}
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    inputMode="numeric" autoComplete="cc-exp" maxLength={5}
                    placeholder="MM / YY" value={cardInfo.expiry}
                    onChange={(e) => {
                      const d = e.target.value.replace(/\D/g, "").slice(0, 4);
                      const f = d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d;
                      setCardInfo({ ...cardInfo, expiry: f });
                    }}
                    className="w-full bg-transparent text-[13px] text-foreground placeholder:text-foreground/40 px-3 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-foreground/20"
                    style={{ border: "1px solid hsla(220 15% 70% / 0.25)" }}
                  />
                  <input
                    inputMode="numeric" autoComplete="cc-csc" maxLength={4}
                    placeholder="CVC" value={cardInfo.cvc}
                    onChange={(e) =>
                      setCardInfo({ ...cardInfo, cvc: e.target.value.replace(/\D/g, "").slice(0, 4) })
                    }
                    className="w-full bg-transparent text-[13px] text-foreground placeholder:text-foreground/40 px-3 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-foreground/20"
                    style={{ border: "1px solid hsla(220 15% 70% / 0.25)" }}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ModelChip({ label }: { label: string }) {
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-medium"
      style={{
        background: "hsla(220 20% 50% / 0.08)",
        color: "hsl(220 15% 35%)",
        border: "1px solid hsla(220 20% 50% / 0.15)",
      }}
    >
      {label}
    </span>
  );
}

function PayButton({
  active, onClick, icon, label, sub,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; sub: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full px-4 py-3 rounded-2xl flex items-center gap-3 transition-all"
      style={{
        background: active ? "hsl(230 25% 15%)" : "hsla(0,0%,100%,0.6)",
        border: `1.5px solid ${active ? "hsl(230 25% 15%)" : "hsla(220 15% 85% / 0.7)"}`,
        color: active ? "white" : "hsl(230 25% 15%)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block text-[13.5px] font-semibold leading-tight">{label}</span>
        <span className={`block text-[11px] mt-0.5 ${active ? "text-white/60" : "text-foreground/50"}`}>{sub}</span>
      </span>
      <span
        className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center"
        style={{
          border: `1.5px solid ${active ? "white" : "hsla(220 15% 60% / 0.5)"}`,
          background: active ? "white" : "transparent",
        }}
      >
        {active && <Check size={10} strokeWidth={3} className="text-foreground" />}
      </span>
    </button>
  );
}
