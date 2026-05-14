import { Check, CreditCard, LogOut, User as UserIcon, Zap } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

/**
 * Account / billing panel — visuals only. Real billing wiring (Stripe checkout,
 * plan upgrade RPC) hasn't been built; Upgrade buttons just alert. Sign out is
 * real (calls useAuth().signOut).
 */

const PLANS = [
  {
    id: "basic" as const,
    label: "Basic",
    price: "$0",
    perks: ["Up to 50 cards / month", "Read-only Composio", "Web only"],
  },
  {
    id: "pro" as const,
    label: "Pro",
    price: "$19",
    perks: [
      "Unlimited cards",
      "All Composio actions",
      "Web + iOS + Android",
      "Priority generation",
    ],
    recommended: true,
  },
  {
    id: "max" as const,
    label: "Max",
    price: "$49",
    perks: ["Everything in Pro", "Multi-account", "Early access to new models"],
  },
];

export default function AccountPanel() {
  const { user, signOut } = useAuth();

  return (
    <div className="h-full overflow-y-auto px-5 pt-6 pb-12">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <UserIcon size={16} className="text-foreground/55" />
          <span className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider">
            Account
          </span>
        </div>
        <h1 className="text-display text-[26px] font-semibold text-foreground mb-6">
          {user?.email ?? "Signed in"}
        </h1>

        <div className="glass-card-strong p-4 mb-6 flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "hsl(292 78% 63% / 0.12)" }}
          >
            <Zap size={18} strokeWidth={2} color="hsl(292 78% 63%)" />
          </div>
          <div className="flex-1">
            <div className="text-[11px] font-semibold text-foreground/50 uppercase tracking-wider">
              Current plan
            </div>
            <div className="text-[16px] font-semibold text-foreground">Pro · trial</div>
          </div>
          <button
            onClick={() => alert("Billing coming soon")}
            className="px-4 h-9 rounded-xl bg-foreground/5 text-[13px] font-medium text-foreground/70 hover:bg-foreground/10 transition-colors"
          >
            Manage
          </button>
        </div>

        <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-2">
          Plans
        </div>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 mb-6">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`glass-card-strong p-4 flex flex-col gap-2 ${
                plan.recommended ? "ring-1 ring-[hsl(292,78%,63%)]/40" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-[15px] font-semibold text-foreground">{plan.label}</div>
                {plan.recommended && (
                  <span className="text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                    Recommended
                  </span>
                )}
              </div>
              <div className="text-[24px] font-bold text-foreground leading-none">
                {plan.price}
                <span className="text-[12px] font-medium text-foreground/45 ml-1">/ mo</span>
              </div>
              <ul className="flex flex-col gap-1.5 mt-2 mb-3">
                {plan.perks.map((p) => (
                  <li key={p} className="flex items-start gap-1.5 text-[12.5px] text-foreground/70">
                    <Check size={12} strokeWidth={2.5} className="text-green-600 mt-1 shrink-0" />
                    {p}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => alert(`Upgrade to ${plan.label} coming soon`)}
                className={
                  plan.recommended
                    ? "w-full h-10 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors"
                    : "w-full h-10 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/70"
                }
              >
                Choose {plan.label}
              </button>
            </div>
          ))}
        </div>

        <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-2">
          Payment method
        </div>
        <div className="glass-card-strong p-4 mb-6 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-foreground/5 flex items-center justify-center shrink-0">
            <CreditCard size={18} strokeWidth={1.5} className="text-foreground/55" />
          </div>
          <div className="flex-1">
            <div className="text-[14px] font-medium text-foreground/85">No card on file</div>
            <div className="text-[12px] text-foreground/55">Add one when you upgrade</div>
          </div>
          <button
            onClick={() => alert("Adding card coming soon")}
            className="px-3 h-9 rounded-xl bg-foreground/5 text-[13px] font-medium text-foreground/65 hover:bg-foreground/10 transition-colors"
          >
            Add
          </button>
        </div>

        <button
          onClick={() => void signOut()}
          className="w-full h-11 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[14px] font-medium text-foreground/70 flex items-center justify-center gap-2"
        >
          <LogOut size={14} strokeWidth={1.5} />
          Sign out
        </button>
      </div>
    </div>
  );
}
