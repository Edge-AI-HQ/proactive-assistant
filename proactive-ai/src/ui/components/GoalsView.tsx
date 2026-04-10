import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Briefcase, Heart, Home, TrendingUp, Sprout, Sparkles,
  Check, Mic, ArrowRightCircle, X, Plus, Loader2,
  type LucideIcon,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { apiFetch, apiPost } from "@/lib/api";
import goalWork from "@/assets/goal-work.png";
import goalHealth from "@/assets/goal-health.png";
import goalFamily from "@/assets/goal-family.png";
import goalFinance from "@/assets/goal-finance.png";
import goalGrowth from "@/assets/goal-growth.png";
import goalLife from "@/assets/goal-life.png";

interface ApiGoal {
  key: string;
  title: string;
  priority: "high" | "medium" | "low";
  status: "active" | "closed";
  summary?: string | null;
}

type VisualStatus = "Normal" | "Alert" | "Watch";

interface GoalVisualMeta {
  icon: LucideIcon;
  image: string;
  label: string;
  pct: number;
  weeklyActions: string[];
  monitoring: string[];
  aiQuestions: string[];
}

const GOAL_VISUAL_META: Record<string, GoalVisualMeta> = {
  "career-growth": {
    icon: Briefcase, image: goalWork, label: "Work", pct: 62,
    weeklyActions: [
      "Review project milestones for this sprint",
      "Follow up on pending decisions",
      "Check team blockers and unblock",
    ],
    monitoring: ["Career development trajectory", "Skill gap analysis", "Industry trends"],
    aiQuestions: ["What skill are you focusing on developing?", "Any career goals shifting this quarter?"],
  },
  "stay-healthy": {
    icon: Heart, image: goalHealth, label: "Health", pct: 35,
    weeklyActions: ["No new health signals this cycle"],
    monitoring: ["Exercise consistency", "Sleep quality trends", "Annual checkup schedule"],
    aiQuestions: ["What health tracking are you currently doing?", "Any specific health topics you're watching?"],
  },
  "financial-plan": {
    icon: TrendingUp, image: goalFinance, label: "Finance", pct: 52,
    weeklyActions: ["Review monthly spending summary", "Check upcoming bills and subscriptions"],
    monitoring: ["Budget vs. actual spending", "Savings rate", "Investment performance"],
    aiQuestions: ["Any budget concerns for this quarter?", "Should I prepare a savings analysis?"],
  },
  "learn-and-grow": {
    icon: Sprout, image: goalGrowth, label: "Growth", pct: 72,
    weeklyActions: ["Continue current learning path", "Review bookmarked articles"],
    monitoring: ["Learning time allocation", "New topics of interest", "Skill acquisition progress"],
    aiQuestions: ["What topic are you most curious about right now?", "Should I find new learning resources?"],
  },
  "relationships": {
    icon: Home, image: goalFamily, label: "Family", pct: 50,
    weeklyActions: ["Plan weekend family activity", "Check in with close friends"],
    monitoring: ["Family event calendar", "Relationship check-in frequency"],
    aiQuestions: ["Any family events coming up?", "How's the work-life balance feeling?"],
  },
  "life-balance": {
    icon: Sparkles, image: goalLife, label: "Life", pct: 40,
    weeklyActions: ["Block personal time on calendar", "Review stress levels"],
    monitoring: ["Personal time allocation", "Burnout risk indicators", "Hobby engagement"],
    aiQuestions: ["Any personal projects you want to prioritize?", "What recharges you most right now?"],
  },
};

const FALLBACK_META: GoalVisualMeta = {
  icon: Sparkles, image: goalLife, label: "Goal", pct: 50,
  weeklyActions: [], monitoring: [], aiQuestions: [],
};

function getVisualMeta(key: string): GoalVisualMeta {
  return GOAL_VISUAL_META[key] ?? FALLBACK_META;
}

function priorityToStatus(priority: string): VisualStatus {
  if (priority === "high") return "Alert";
  if (priority === "low") return "Watch";
  return "Normal";
}

const statusColor: Record<VisualStatus, string> = {
  Normal: "bg-emerald-400/30",
  Alert: "bg-rose-400/30",
  Watch: "bg-amber-400/30",
};

const statusBarColor: Record<VisualStatus, string> = {
  Normal: "bg-emerald-400/50",
  Alert: "bg-rose-400/50",
  Watch: "bg-amber-400/50",
};

export default function GoalsView() {
  const [goals, setGoals] = useState<ApiGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState<"high" | "medium" | "low">("medium");
  const [saving, setSaving] = useState(false);

  const loadGoals = useCallback(async () => {
    try {
      const res = await apiFetch("/api/profile/goals");
      const data = await res.json();
      if (data.ok && Array.isArray(data.goals)) setGoals(data.goals);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadGoals(); }, [loadGoals]);

  const activeGoals = goals.filter((g) => g.status === "active");

  const handleAddGoal = async () => {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, "-");
    const title = newTitle.trim();
    if (!key || !title) return;
    setSaving(true);
    try {
      const res = await apiPost("/api/profile/goals", { key, title, priority: newPriority });
      const data = await res.json();
      if (data.ok) {
        setNewKey(""); setNewTitle(""); setNewPriority("medium");
        setShowAddForm(false);
        await loadGoals();
      }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const selectedApiGoal = expandedGoal ? activeGoals.find((g) => g.key === expandedGoal) : null;
  const selectedMeta = selectedApiGoal ? getVisualMeta(selectedApiGoal.key) : null;
  const selectedStatus = selectedApiGoal ? priorityToStatus(selectedApiGoal.priority) : "Normal";

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto relative">
      <div className="flex items-center justify-between mb-1 pr-20">
        <h1 className="text-display text-2xl text-foreground">Goals</h1>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          <Plus size={14} />
          Add Goal
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {activeGoals.length} Baskets · Tap to expand
      </p>

      {/* Add Goal Form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden mb-4"
          >
            <div className="glass-card-strong p-4 space-y-3">
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="Key (e.g. learn-spanish)"
                className="w-full rounded-xl bg-foreground/5 border border-foreground/10 px-3 py-2 text-xs text-foreground font-mono placeholder:text-foreground/25 focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Title (e.g. Learn conversational Spanish)"
                className="w-full rounded-xl bg-foreground/5 border border-foreground/10 px-3 py-2 text-xs text-foreground placeholder:text-foreground/25 focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <div className="flex items-center gap-2">
                {(["high", "medium", "low"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setNewPriority(p)}
                    className={`flex-1 py-1.5 rounded-xl text-[11px] font-medium transition-colors ${
                      newPriority === p
                        ? "bg-foreground text-background"
                        : "bg-foreground/5 text-foreground/50 hover:bg-foreground/10"
                    }`}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddForm(false)}
                  className="flex-1 py-2 rounded-xl text-xs font-medium text-foreground/50 bg-foreground/5 hover:bg-foreground/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddGoal}
                  disabled={saving || !newKey.trim() || !newTitle.trim()}
                  className="flex-1 py-2 rounded-xl text-xs font-semibold bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-40"
                >
                  {saving ? <Loader2 size={14} className="animate-spin mx-auto" /> : "Add"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading && (
        <div className="flex items-center justify-center py-8 gap-2">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">Loading goals...</span>
        </div>
      )}

      {!loading && activeGoals.length === 0 && (
        <div className="glass-card-strong p-8 text-center mb-4">
          <Sparkles size={28} className="mx-auto mb-3 text-foreground/50" />
          <p className="text-display text-foreground mb-1">No active goals</p>
          <p className="text-sm text-muted-foreground">
            Add goals to help your AI generate more relevant intent cards
          </p>
        </div>
      )}

      {/* 2-Column Grid */}
      <div className="grid grid-cols-2 gap-3">
        {activeGoals.map((goal, i) => {
          const meta = getVisualMeta(goal.key);
          const status = priorityToStatus(goal.priority);
          const Icon = meta.icon;

          return (
            <div
              key={goal.key}
              className="glass-card-strong cursor-pointer active:scale-[0.97] transition-transform overflow-hidden"
              onClick={() => setExpandedGoal(goal.key)}
            >
              <div className="w-full h-24 overflow-hidden bg-foreground/[0.03] flex items-center justify-center">
                <img
                  src={meta.image}
                  alt={meta.label}
                  className={`w-auto object-contain ${meta.label === "Growth" ? "h-[70%]" : "h-full"}`}
                />
              </div>
              <div className="p-3.5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-foreground"><Icon size={20} /></span>
                  <span className="text-display text-sm text-foreground">{meta.label}</span>
                </div>

                <div className="w-full h-1.5 rounded-full bg-foreground/10 mb-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${statusColor[status]} transition-all duration-700 ease-out`}
                    style={{ width: `${meta.pct}%` }}
                  />
                </div>

                <div className="flex justify-between items-center mb-2">
                  <span className="text-display text-lg text-foreground">{meta.pct}%</span>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                    status === "Alert" ? "bg-rose-50 text-rose-400"
                    : status === "Watch" ? "bg-amber-50 text-amber-500"
                    : "bg-emerald-50 text-emerald-500"
                  }`}>{status}</span>
                </div>

                <div className="flex justify-between items-end">
                  <p className="text-[11px] text-foreground/50 leading-snug flex-1 line-clamp-2">
                    {goal.summary || goal.title}
                  </p>
                  <ArrowRightCircle size={16} className="text-foreground/25 shrink-0 ml-1" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail Drawer */}
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
            <DrawerTitle>{selectedMeta?.label || "Goal"}</DrawerTitle>
            <DrawerDescription>Goal detail view</DrawerDescription>
          </DrawerHeader>

          {selectedApiGoal && selectedMeta && (
            <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <img src={selectedMeta.image} alt={selectedMeta.label} width={32} height={32} className="w-8 h-8 object-contain" />
                  <span className="text-display text-lg text-foreground font-semibold">{selectedMeta.label}</span>
                  <span className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
                    selectedStatus === "Alert" ? "bg-rose-50 text-rose-400"
                    : selectedStatus === "Watch" ? "bg-amber-50 text-amber-500"
                    : "bg-emerald-50 text-emerald-500"
                  }`}>{selectedStatus}</span>
                </div>
                <span className={`text-display text-lg font-semibold ${
                  selectedStatus === "Alert" ? "text-rose-400"
                  : selectedStatus === "Watch" ? "text-amber-500"
                  : "text-emerald-500"
                }`}>{selectedMeta.pct}%</span>
              </div>

              {/* Progress bar */}
              <div className="w-full h-2 rounded-full bg-foreground/5 mb-4 overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${statusBarColor[selectedStatus]}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${selectedMeta.pct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              </div>

              <p className="text-sm text-foreground/80 mb-4">
                {selectedApiGoal.summary || selectedApiGoal.title}
              </p>

              <div className="w-full h-px bg-foreground/10 mb-4" />

              {/* AI Weekly Actions */}
              <h3 className="text-xs font-semibold text-emerald-500 uppercase tracking-wider mb-3">
                AI Weekly Actions
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedMeta.weeklyActions.map((action, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" />
                    <span className="text-sm text-foreground/80 leading-snug">{action}</span>
                  </div>
                ))}
              </div>

              {/* Monitoring */}
              <h3 className="text-xs font-semibold text-amber-500 uppercase tracking-wider mb-3">
                Monitoring
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedMeta.monitoring.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400 mt-1 shrink-0 animate-pulse" />
                    <span className="text-sm text-foreground/75 leading-snug">{item}</span>
                  </div>
                ))}
              </div>

              {/* AI wants to know */}
              <h3 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-3">
                AI wants to know
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedMeta.aiQuestions.map((q, i) => (
                  <button
                    key={i}
                    className="w-full flex items-center gap-3 p-3.5 rounded-2xl border border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.07] active:bg-foreground/[0.1] transition-all text-left group"
                  >
                    <div className="w-8 h-8 rounded-full bg-foreground flex items-center justify-center shrink-0">
                      <Mic size={14} className="text-background" />
                    </div>
                    <span className="text-sm text-foreground/80 leading-snug flex-1">{q}</span>
                    <ArrowRightCircle size={14} className="text-foreground shrink-0" />
                  </button>
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
