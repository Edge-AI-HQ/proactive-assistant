import { motion } from "framer-motion";
import {
  Sparkles, Check, Bell, SlidersHorizontal, ShieldCheck,
} from "lucide-react";

export default function AccountPanel() {
  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      {/* Header */}
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Account</h1>
      <p className="text-xs text-muted-foreground mb-5">Profile · Subscription · Preferences</p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        {/* Profile card */}
        <div className="glass-card-strong p-4 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0">
            <span className="text-base font-semibold text-foreground/70">B</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Ben Wu</p>
            <p className="text-[11px] text-foreground/50 truncate">ben@pin.ai · Member since Mar 2024</p>
          </div>
          <button className="text-[11px] font-medium text-foreground border border-foreground/12 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors">
            Edit
          </button>
        </div>

        {/* Subscription & Billing */}
        <div className="glass-card-strong p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
              <Sparkles size={16} strokeWidth={1.5} className="text-foreground/70" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Subscription & Billing</p>
              <p className="text-[11px] text-foreground/50 mt-0.5">Current: Pro · 7-day trial</p>
            </div>
          </div>

          {/* Basic */}
          <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-foreground">Basic</span>
                <span className="text-base font-semibold text-foreground">$39</span>
                <span className="text-[11px] text-foreground/40">/ mo</span>
              </div>
              <button className="text-[11px] font-semibold text-foreground border border-foreground/15 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors">
                Switch
              </button>
            </div>
            <p className="text-[11px] text-foreground/55 mb-2">1,500 credits / mo · Local Gemma 2B · Cloud Gemini Flash</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {["Daily card feed", "Connect 3 apps", "Email + Calendar"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.5} className="text-foreground/40 flex-shrink-0" />
                  <span className="text-[11px] text-foreground/55">{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pro (current / most popular) */}
          <div className="relative rounded-2xl border-2 border-[hsl(304_75%_63%/0.45)] bg-[hsl(304_75%_63%/0.04)] p-3.5">
            <div className="absolute -top-2.5 right-3 bg-[hsl(304_75%_63%)] text-white text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full">
              Current · Most Popular
            </div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-foreground">Pro</span>
                <span className="text-base font-semibold text-[hsl(304_75%_63%)]">$99</span>
                <span className="text-[11px] text-foreground/40">/ mo</span>
              </div>
              <span className="text-[11px] font-medium text-[hsl(304_75%_63%)]">Active</span>
            </div>
            <p className="text-[11px] text-foreground/60 mb-2">6,000 credits / mo · Local Llama 3 8B · Cloud Claude Sonnet</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {["Everything in Basic", "Connect unlimited apps", "Voice + Ambient mode", "Priority execution"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.5} className="text-[hsl(304_75%_63%)] flex-shrink-0" />
                  <span className="text-[11px] text-foreground/70">{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Max */}
          <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-foreground">Max</span>
                <span className="text-base font-semibold text-foreground">$199</span>
                <span className="text-[11px] text-foreground/40">/ mo</span>
              </div>
              <button className="text-[11px] font-semibold text-background bg-foreground rounded-lg px-3 py-1 hover:opacity-90 transition-opacity">
                Upgrade
              </button>
            </div>
            <p className="text-[11px] text-foreground/55 mb-2">20,000 credits / mo · Local Llama 3 70B · Cloud Claude Opus / GPT-5</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {["Everything in Pro", "Custom personas", "Team sharing", "Early access models"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.5} className="text-foreground/40 flex-shrink-0" />
                  <span className="text-[11px] text-foreground/55">{f}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Section rows */}
        {[
          { icon: Bell, name: "Push Notifications", desc: "What gets through — even during quiet hours" },
          { icon: SlidersHorizontal, name: "Preferences", desc: "Quiet hours, voice, tone" },
          { icon: ShieldCheck, name: "Privacy & Data", desc: "On-device by default · TEE-protected" },
        ].map((row) => {
          const RowIcon = row.icon;
          return (
            <button
              key={row.name}
              className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
            >
              <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
                <RowIcon size={16} strokeWidth={1.5} className="text-foreground/70" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{row.name}</p>
                <p className="text-[11px] text-foreground/50 mt-0.5">{row.desc}</p>
              </div>
            </button>
          );
        })}
      </motion.div>
    </div>
  );
}
