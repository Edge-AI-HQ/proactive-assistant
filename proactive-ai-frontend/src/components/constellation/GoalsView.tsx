import { useState } from "react";
import { motion } from "framer-motion";
import { Briefcase, Heart, Home, TrendingUp, Sprout, Sparkles, Check, ArrowRightCircle } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import goalWork from "@/assets/goal-work.png";
import goalHealth from "@/assets/goal-health.png";
import goalFamily from "@/assets/goal-family.png";
import goalFinance from "@/assets/goal-finance.png";
import goalGrowth from "@/assets/goal-growth.png";
import goalLife from "@/assets/goal-life.png";

interface GoalDetail {
  icon: React.ReactNode;
  image: string;
  label: string;
  pct: number;
  status: "Normal" | "Alert" | "Watch";
  description: string;
  weeklyActions: string[];
  monitoring: string[];
  aiQuestions: string[];
}

const GOALS: GoalDetail[] = [
  {
    icon: <Briefcase size={20} />, image: goalWork, label: "Work", pct: 62, status: "Normal",
    description: "DemoAI product launch + team expansion",
    weeklyActions: [
      "Meeting with Partner today — brief prepared",
      "New Marketing Head application received",
      "Team Member A blocked on Supabase access",
      "TG refund flow needs prod testing",
      "Team Meeting Mon 3/30 agenda suggested",
    ],
    monitoring: [
      "Team hiring — Marketing Head candidate",
      "Supabase migration progress",
      "TG subscription refund flow",
      "Monday all-hands agenda",
      "Founder-CoFounder-Advisor Tuesday meeting",
    ],
    aiQuestions: [
      "What position are you prioritizing hiring for?",
      "Should I schedule a Supabase access review?",
      "Any topics you want added to Monday's agenda?",
    ],
  },
  {
    icon: <Heart size={20} />, image: goalHealth, label: "Health", pct: 35, status: "Alert",
    description: "Watch long-term Health and biomarker optimization",
    weeklyActions: ["No new health signals this cycle"],
    monitoring: [
      "New longevity research",
      "Annual health checkup schedule",
      "Sleep and exercise data",
    ],
    aiQuestions: [
      "What health tracking are you currently doing?",
      "Any specific health topics you're watching?",
      "Have you scheduled an annual health checkup?",
    ],
  },
  {
    icon: <Home size={20} />, image: goalFamily, label: "Family", pct: 50, status: "Watch",
    description: "Balance Work and Family time",
    weeklyActions: ["Weekend family dinner planned", "Kids school event on Thursday"],
    monitoring: [
      "Family vacation planning",
      "Work-life balance score",
    ],
    aiQuestions: [
      "Any family events coming up this week?",
      "How's the work-life balance feeling lately?",
    ],
  },
  {
    icon: <TrendingUp size={20} />, image: goalFinance, label: "Finance", pct: 52, status: "Alert",
    description: "Ensure Finance compliance + runway management",
    weeklyActions: ["Q1 financial review due", "Invoice batch approved"],
    monitoring: [
      "Runway forecast update",
      "Tax filing deadline",
      "Subscription cost optimization",
    ],
    aiQuestions: [
      "Any budget concerns for this quarter?",
      "Should I prepare a runway analysis?",
    ],
  },
  {
    icon: <Sprout size={20} />, image: goalGrowth, label: "Growth", pct: 72, status: "Normal",
    description: "Stay at forefront of AI/Agent ecosystem",
    weeklyActions: ["New AI paper summarized", "Agent framework comparison updated"],
    monitoring: [
      "OpenAI API changes",
      "Competitor product launches",
      "Community feedback trends",
    ],
    aiQuestions: [
      "Any new AI topics you want to deep dive into?",
      "Should I track any new competitors?",
    ],
  },
  {
    icon: <Sparkles size={20} />, image: goalLife, label: "Life", pct: 40, status: "Watch",
    description: "Meaningful travel and personal fulfillment",
    weeklyActions: ["Travel itinerary draft ready"],
    monitoring: [
      "Upcoming travel windows",
      "Personal project backlog",
    ],
    aiQuestions: [
      "Any destinations you're considering?",
      "What personal projects are most exciting right now?",
    ],
  },
];

const statusColor: Record<GoalDetail["status"], string> = {
  Normal: "bg-emerald-400/30",
  Alert: "bg-rose-400/30",
  Watch: "bg-amber-400/30",
};

const statusBarColor: Record<GoalDetail["status"], string> = {
  Normal: "bg-emerald-400/50",
  Alert: "bg-rose-400/50",
  Watch: "bg-amber-400/50",
};

export default function GoalsView() {
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  const selectedGoal = expandedGoal ? GOALS.find(g => g.label === expandedGoal) : null;

  return (
    <div className="flex flex-col h-full overflow-y-auto relative space-y-3">
      <div className="px-1">
        <h2 className="text-base font-semibold text-foreground">Goals</h2>
        <p className="text-[12px] text-foreground/55 leading-relaxed mt-1">
          Share your goals — help AI know you. Tap any basket to expand.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {GOALS.map((g, i) => (
          <motion.div
            key={g.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08, duration: 0.4 }}
            className="glass-card-strong cursor-pointer active:scale-[0.97] transition-transform overflow-hidden"
            onClick={() => setExpandedGoal(g.label)}
          >
            <div className="w-full h-24 overflow-hidden bg-foreground/[0.03] flex items-center justify-center">
              <img
                src={g.image}
                alt={g.label}
                loading="lazy"
                className={`w-auto object-contain ${g.label === "Growth" ? "h-[70%]" : "h-full"}`}
              />
            </div>
            <div className="p-3.5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-foreground">{g.icon}</span>
                <span className="text-display text-sm text-foreground">{g.label}</span>
              </div>

              <div className="w-full h-1.5 rounded-full bg-foreground/10 mb-2 overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${statusColor[g.status]}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${g.pct}%` }}
                  transition={{ delay: i * 0.08 + 0.3, duration: 0.6, ease: "easeOut" }}
                />
              </div>

              <div className="flex justify-between items-center mb-2">
                <span className="text-display text-lg text-foreground">{g.pct}%</span>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                  g.status === "Alert" ? "bg-rose-50 text-rose-400 dark:bg-rose-400/10"
                  : g.status === "Watch" ? "bg-amber-50 text-amber-500 dark:bg-amber-400/10"
                  : "bg-emerald-50 text-emerald-500 dark:bg-emerald-400/10"
                }`}>{g.status}</span>
              </div>

              <div className="flex justify-between items-end">
                <p className="text-[11px] text-foreground/50 leading-snug flex-1 line-clamp-2">{g.description}</p>
                <ArrowRightCircle size={16} className="text-foreground/25 shrink-0 ml-1" />
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <Drawer open={!!expandedGoal} onOpenChange={(open) => { if (!open) setExpandedGoal(null); }}>
        <DrawerContent
          className="max-h-[85vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{selectedGoal?.label || "Goal"}</DrawerTitle>
            <DrawerDescription>Goal detail view</DrawerDescription>
          </DrawerHeader>

          {selectedGoal && (
            <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <img src={selectedGoal.image} alt={selectedGoal.label} width={32} height={32} className="w-8 h-8 object-contain" />
                  <span className="text-display text-lg text-foreground font-semibold">{selectedGoal.label}</span>
                  <span className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
                    selectedGoal.status === "Alert" ? "bg-rose-50 text-rose-400 dark:bg-rose-400/10"
                    : selectedGoal.status === "Watch" ? "bg-amber-50 text-amber-500 dark:bg-amber-400/10"
                    : "bg-emerald-50 text-emerald-500 dark:bg-emerald-400/10"
                  }`}>{selectedGoal.status}</span>
                </div>
                <span className={`text-display text-lg font-semibold ${
                  selectedGoal.status === "Alert" ? "text-rose-400"
                  : selectedGoal.status === "Watch" ? "text-amber-500"
                  : "text-emerald-500"
                }`}>{selectedGoal.pct}%</span>
              </div>

              <div className="w-full h-2 rounded-full bg-foreground/5 mb-4 overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${statusBarColor[selectedGoal.status]}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${selectedGoal.pct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              </div>

              <p className="text-sm text-foreground/80 mb-4">{selectedGoal.description}</p>

              <div className="w-full h-px bg-foreground/10 mb-4" />

              <h3 className="text-xs font-semibold text-emerald-500 uppercase tracking-wider mb-3">AI Weekly Actions</h3>
              <div className="space-y-2.5 mb-5">
                {selectedGoal.weeklyActions.map((action, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" />
                    <span className="text-sm text-foreground/80 leading-snug">{action}</span>
                  </div>
                ))}
              </div>

              <h3 className="text-xs font-semibold text-amber-500 uppercase tracking-wider mb-3">Monitoring</h3>
              <div className="space-y-2.5 mb-5">
                {selectedGoal.monitoring.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400 mt-1 shrink-0 animate-pulse" />
                    <span className="text-sm text-foreground/75 leading-snug">{item}</span>
                  </div>
                ))}
              </div>

              <h3 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-3">
                AI wants to know
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedGoal.aiQuestions.map((q, i) => (
                  <div
                    key={i}
                    className="w-full flex items-center gap-3 p-3.5 rounded-2xl border border-foreground/10 bg-foreground/[0.03] text-left group"
                  >
                    <div className="w-8 h-8 rounded-full bg-foreground flex items-center justify-center shrink-0">
                      <Sparkles size={14} className="text-background" />
                    </div>
                    <span className="text-sm text-foreground/80 leading-snug flex-1">{q}</span>
                    <ArrowRightCircle size={14} className="text-foreground shrink-0" />
                  </div>
                ))}
              </div>

              <button className="w-full py-3.5 rounded-2xl bg-foreground/[0.04] text-sm text-foreground/50 font-medium hover:bg-foreground/[0.07] transition-colors">
                Lock Goals — AI watches only, no modify
              </button>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
