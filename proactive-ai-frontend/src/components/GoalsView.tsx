import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Briefcase, Heart, TrendingUp, Sprout, Sparkles, Users,
  X, Plus, Loader2, Check, ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { proxyFetch, proxyPost } from "@/lib/api";

interface Goal {
  key: string;
  title: string;
  priority: "high" | "medium" | "low";
  status: "active" | "closed";
  summary?: string;
}

const GOAL_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  "career-growth":   { icon: Briefcase,   label: "Career" },
  "stay-healthy":    { icon: Heart,        label: "Health" },
  "financial-plan":  { icon: TrendingUp,   label: "Finance" },
  "learn-and-grow":  { icon: Sprout,       label: "Growth" },
  "relationships":   { icon: Users,        label: "Relationships" },
  "life-balance":    { icon: Sparkles,     label: "Life Balance" },
  work:              { icon: Briefcase,     label: "Work" },
  health:            { icon: Heart,         label: "Health" },
  finance:           { icon: TrendingUp,    label: "Finance" },
  growth:            { icon: Sprout,        label: "Growth" },
  family:            { icon: Users,         label: "Family" },
  life:              { icon: Sparkles,      label: "Life" },
};

const FALLBACK_ICON = { icon: Sparkles, label: "Goal" };

function goalMeta(key: string) {
  return GOAL_ICONS[key] ?? GOAL_ICONS[key.split("-")[0]] ?? FALLBACK_ICON;
}

const PRIORITY_STYLE: Record<string, string> = {
  high:   "bg-rose-500/10 text-rose-500",
  medium: "bg-amber-500/10 text-amber-500",
  low:    "bg-foreground/5 text-foreground/40",
};

export default function GoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState<"high" | "medium" | "low">("medium");
  const [saving, setSaving] = useState(false);
  const [closingKey, setClosingKey] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  const loadGoals = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const res = await proxyFetch("/profile/goals", { signal: controller.signal });
      const data = await res.json();
      if (!controller.signal.aborted && data.ok && Array.isArray(data.goals)) {
        setGoals(data.goals);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.warn("[GoalsView] loadGoals failed:", err);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGoals();
    return () => controllerRef.current?.abort();
  }, [loadGoals]);

  const activeGoals = goals.filter(g => g.status === "active");
  const closedGoals = goals.filter(g => g.status === "closed");

  const handleAddGoal = async () => {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, "-");
    const title = newTitle.trim();
    if (!key || !title) return;
    setSaving(true);
    try {
      const res = await proxyPost("/profile/goals", { key, title, priority: newPriority });
      const data = await res.json();
      if (data.ok) {
        setNewKey("");
        setNewTitle("");
        setNewPriority("medium");
        setShowAddForm(false);
        await loadGoals();
      }
    } catch (err) {
      console.warn("[GoalsView] addGoal failed:", err);
    } finally { setSaving(false); }
  };

  const handleCloseGoal = async (key: string) => {
    setClosingKey(key);
    try {
      await proxyPost("/profile/goals/close", { key });
      await loadGoals();
    } catch (err) {
      console.warn("[GoalsView] closeGoal failed:", err);
    } finally { setClosingKey(null); }
  };

  return (
    <div className="flex flex-col h-full px-4 pt-3 pb-24 overflow-y-auto scrollbar-hidden">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-display text-2xl text-foreground">Goals</h1>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          <Plus size={14} />
          Add Goal
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">Your active goals and priorities</p>

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
                className="w-full rounded-xl bg-foreground/5 border border-foreground/10 px-3 py-2 text-xs text-foreground font-mono placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Title (e.g. Learn conversational Spanish)"
                className="w-full rounded-xl bg-foreground/5 border border-foreground/10 px-3 py-2 text-xs text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
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

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-8 gap-2">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">Loading goals...</span>
        </div>
      )}

      {/* Active Goals */}
      {!loading && activeGoals.length === 0 && (
        <div className="glass-card-strong p-8 text-center mb-4">
          <Sparkles size={28} className="mx-auto mb-3 text-foreground/50" />
          <p className="text-display text-foreground mb-1">No active goals</p>
          <p className="text-sm text-muted-foreground">
            Add goals to help your AI generate more relevant intent cards
          </p>
        </div>
      )}

      <div className="space-y-2.5">
        {activeGoals.map((goal, i) => {
          const meta = goalMeta(goal.key);
          const Icon = meta.icon;
          const isExpanded = expandedKey === goal.key;
          const isClosing = closingKey === goal.key;

          return (
            <motion.div
              key={goal.key}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <div className="glass-card-strong overflow-hidden">
                <button
                  onClick={() => setExpandedKey(isExpanded ? null : goal.key)}
                  className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-foreground/5"
                >
                  <div className="w-10 h-10 rounded-xl bg-foreground/5 flex items-center justify-center flex-shrink-0">
                    <Icon size={18} strokeWidth={1.5} className="text-foreground/60" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-foreground truncate">{goal.title}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-foreground/30">{goal.key}</span>
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${PRIORITY_STYLE[goal.priority] ?? PRIORITY_STYLE.medium}`}>
                        {goal.priority}
                      </span>
                    </div>
                  </div>
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    className={`text-foreground/25 transition-transform duration-200 flex-shrink-0 ${isExpanded ? "rotate-180" : ""}`}
                  />
                </button>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4">
                        <div className="h-px bg-foreground/10 mb-3" />
                        {goal.summary && (
                          <p className="text-[13px] text-foreground/60 leading-relaxed mb-3">{goal.summary}</p>
                        )}
                        <button
                          onClick={() => handleCloseGoal(goal.key)}
                          disabled={isClosing}
                          className="w-full py-2.5 rounded-xl text-xs font-medium text-foreground/50 bg-foreground/5 hover:bg-foreground/10 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
                        >
                          {isClosing ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <>
                              <Check size={12} />
                              Close Goal
                            </>
                          )}
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Closed Goals */}
      {closedGoals.length > 0 && (
        <div className="mt-6">
          <span className="text-xs font-semibold text-foreground/25 uppercase tracking-wider mb-3 block">
            Closed ({closedGoals.length})
          </span>
          <div className="space-y-1.5">
            {closedGoals.map((goal) => {
              const meta = goalMeta(goal.key);
              const Icon = meta.icon;
              return (
                <div key={goal.key} className="glass-card px-4 py-3 flex items-center gap-3 opacity-50">
                  <Icon size={14} strokeWidth={1.5} className="text-foreground/30 flex-shrink-0" />
                  <span className="text-xs text-foreground/40 line-through flex-1">{goal.title}</span>
                  <X size={10} className="text-foreground/20" />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
