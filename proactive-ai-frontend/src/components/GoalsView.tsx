import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Briefcase,
  Check,
  ChevronDown,
  Heart,
  Loader2,
  Plus,
  Sparkles,
  Sprout,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  fetchProfileSnapshot,
  proxyPost,
  type Goal,
  type ProfileInterest,
  type ProfileMemory,
  type ProfileSignal,
  type ProfileSnapshot,
} from "@/lib/api";

type MemoryTab = "entry" | "event";
type ProfileGroupKey = "facts" | "preferences" | "constraints" | "metadata";
type SectionId = "memory" | "signals" | "interests" | "goals";

const EMPTY_SNAPSHOT: ProfileSnapshot = {
  profile: null,
  goals: [],
  memories: [],
  signals: [],
  interests: [],
};

const GOAL_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  "career-growth": { icon: Briefcase, label: "Career" },
  "stay-healthy": { icon: Heart, label: "Health" },
  "financial-plan": { icon: TrendingUp, label: "Finance" },
  "learn-and-grow": { icon: Sprout, label: "Growth" },
  relationships: { icon: Users, label: "Relationships" },
  "life-balance": { icon: Sparkles, label: "Life Balance" },
  work: { icon: Briefcase, label: "Work" },
  health: { icon: Heart, label: "Health" },
  finance: { icon: TrendingUp, label: "Finance" },
  growth: { icon: Sprout, label: "Growth" },
  family: { icon: Users, label: "Family" },
  life: { icon: Sparkles, label: "Life" },
};

const FALLBACK_ICON = { icon: Sparkles, label: "Goal" };

const PRIORITY_STYLE: Record<string, string> = {
  critical: "bg-violet-500/10 text-violet-600",
  high: "bg-rose-500/10 text-rose-500",
  medium: "bg-amber-500/10 text-amber-500",
  low: "bg-foreground/5 text-foreground/40",
};

const PROFILE_GROUP_META: Array<{
  key: ProfileGroupKey;
  title: string;
  description: string;
}> = [
  { key: "facts", title: "Facts", description: "Stable details the assistant knows about you." },
  { key: "preferences", title: "Preferences", description: "How you prefer the assistant to behave." },
  { key: "constraints", title: "Constraints", description: "Rules and boundaries the assistant should honor." },
  { key: "metadata", title: "Metadata", description: "System-managed fields attached to your profile." },
];

function goalMeta(key: string) {
  return GOAL_ICONS[key] ?? GOAL_ICONS[key.split("-")[0]] ?? FALLBACK_ICON;
}

function formatDateTime(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatMetric(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return value.toFixed(digits);
}

function isEventMemory(memory: ProfileMemory): boolean {
  return memory.kind.trim().toLowerCase() === "event";
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.03] px-4 py-5 text-center">
      <p className="text-sm font-medium text-foreground/70">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground/45">{description}</p>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-2xl bg-white/45 px-3 py-3 text-left ring-1 ring-white/50 transition-colors hover:bg-white/75"
    >
      <div className="text-[10px] uppercase tracking-[0.18em] text-foreground/35">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </button>
  );
}

function ProfileGroupCard({
  title,
  description,
  values,
  expanded,
  onToggle,
}: {
  title: string;
  description: string;
  values: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const entries = Object.entries(values);

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium text-foreground/45">
              {entries.length}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/42">{description}</p>
        </div>
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={`shrink-0 text-foreground/25 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-foreground/8 px-4 py-3">
              {entries.length === 0 ? (
                <EmptyState
                  title={`No ${title.toLowerCase()} yet`}
                  description="This group is empty right now."
                />
              ) : (
                <div className="space-y-3">
                  {entries.map(([key, value]) => (
                    <div
                      key={key}
                      className="rounded-2xl bg-foreground/[0.03] px-3 py-3"
                    >
                      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-foreground/38">
                        {key}
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/72">
                        {formatValue(value)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MemoryItem({ memory }: { memory: ProfileMemory }) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full bg-foreground/5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/42">
          {memory.kind}
        </span>
        <span className="text-[11px] text-foreground/35">{formatDateTime(memory.created_at)}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-foreground/78">{memory.text}</p>
      {memory.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {memory.tags.map((tag) => (
            <span
              key={`${memory.id}-${tag}`}
              className="rounded-full bg-white/65 px-2 py-1 text-[10px] font-medium text-foreground/45 ring-1 ring-white/60"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalItem({ signal }: { signal: ProfileSignal }) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {signal.target_type} / {signal.target_key}
          </div>
          <div className="mt-1 text-xs text-foreground/45">
            {signal.kind}
            {typeof signal.value === "number" ? ` · value ${formatMetric(signal.value)}` : ""}
            {signal.source ? ` · ${signal.source}` : ""}
          </div>
        </div>
        <span className="text-[11px] text-foreground/35">{formatDateTime(signal.occurred_at)}</span>
      </div>
      {signal.context && Object.keys(signal.context).length > 0 && (
        <pre className="mt-3 whitespace-pre-wrap break-words rounded-2xl bg-white/55 px-3 py-3 text-[11px] leading-5 text-foreground/62 ring-1 ring-white/60">
          {formatValue(signal.context)}
        </pre>
      )}
    </div>
  );
}

function InterestItem({ interest }: { interest: ProfileInterest }) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {interest.kind} / {interest.key}
          </div>
          <div className="mt-1 text-xs text-foreground/45">
            score {formatMetric(interest.score)} · confidence {formatMetric(interest.confidence)} · evidence {interest.evidence_count}
          </div>
        </div>
        <span className="rounded-full bg-foreground/5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/42">
          {interest.status}
        </span>
      </div>
      <div className="mt-3 text-[11px] text-foreground/38">
        Last signal: {formatDateTime(interest.last_signal_at)}
      </div>
    </div>
  );
}

export default function GoalsView() {
  const [snapshot, setSnapshot] = useState<ProfileSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState<"high" | "medium" | "low">("medium");
  const [saving, setSaving] = useState(false);
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [memoryTab, setMemoryTab] = useState<MemoryTab>("entry");
  const [openGroups, setOpenGroups] = useState<Record<ProfileGroupKey, boolean>>({
    facts: false,
    preferences: false,
    constraints: false,
    metadata: false,
  });

  const controllerRef = useRef<AbortController | null>(null);

  const loadSnapshot = useCallback(async (options?: { silent?: boolean }) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    if (!options?.silent) setLoading(true);
    setError(null);

    try {
      const data = await fetchProfileSnapshot(controller.signal);
      if (!controller.signal.aborted) {
        setSnapshot(data);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : "Failed to load profile";
        console.warn("[GoalsView] loadSnapshot failed:", err);
        setError(message);
      }
    } finally {
      if (!controller.signal.aborted && !options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
    return () => controllerRef.current?.abort();
  }, [loadSnapshot]);

  const profile = snapshot.profile;
  const activeGoals = useMemo(
    () => snapshot.goals.filter((goal) => goal.status !== "closed"),
    [snapshot.goals],
  );
  const closedGoals = useMemo(
    () => snapshot.goals.filter((goal) => goal.status === "closed"),
    [snapshot.goals],
  );
  const eventMemories = useMemo(
    () => snapshot.memories.filter(isEventMemory),
    [snapshot.memories],
  );
  const entryMemories = useMemo(
    () => snapshot.memories.filter((memory) => !isEventMemory(memory)),
    [snapshot.memories],
  );
  const visibleMemories = memoryTab === "event" ? eventMemories : entryMemories;

  const scrollToSection = useCallback((sectionId: SectionId) => {
    const element = document.getElementById(`profile-section-${sectionId}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleAddGoal = async () => {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, "-");
    const title = newTitle.trim();
    if (!key || !title) return;

    setSaving(true);
    try {
      const res = await proxyPost("/profile/goals", { key, title, priority: newPriority });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `Failed to add goal: ${res.status}`);
      }
      setNewKey("");
      setNewTitle("");
      setNewPriority("medium");
      setShowAddForm(false);
      await loadSnapshot({ silent: true });
    } catch (err) {
      console.warn("[GoalsView] addGoal failed:", err);
      setError(err instanceof Error ? err.message : "Failed to add goal");
    } finally {
      setSaving(false);
    }
  };

  const handleCloseGoal = async (key: string) => {
    setClosingKey(key);
    try {
      const res = await proxyPost("/profile/goals/close", { key });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `Failed to close goal: ${res.status}`);
      }
      await loadSnapshot({ silent: true });
    } catch (err) {
      console.warn("[GoalsView] closeGoal failed:", err);
      setError(err instanceof Error ? err.message : "Failed to close goal");
    } finally {
      setClosingKey(null);
    }
  };

  const toggleGroup = (group: ProfileGroupKey) => {
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  const sectionMotion = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.24 },
  };

  return (
    <div className="scrollbar-hidden flex h-full flex-col overflow-y-auto px-4 pb-24 pt-3">
      <div className="mb-6">
        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
          Profile Snapshot
        </div>
        <h1 className="text-display mt-1 text-2xl text-foreground">Profile</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Your current profile, memory, signals, interests, and active goals in one place.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-14">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">Loading profile snapshot...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <motion.section {...sectionMotion} className="glass-card-strong p-4">
              <p className="text-sm font-medium text-rose-500">Could not refresh profile snapshot.</p>
              <p className="mt-1 text-xs leading-5 text-foreground/55">{error}</p>
            </motion.section>
          )}

          <motion.section {...sectionMotion} className="glass-card-strong p-5">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-[0.18em] text-foreground/35">
                  Current Profile
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="text-display text-xl text-foreground">
                    {profile?.display_name?.trim() || "Unnamed user"}
                  </h2>
                  <span className="rounded-full bg-foreground/5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/42">
                    {profile?.locale ?? "n/a"}
                  </span>
                  <span className="rounded-full bg-foreground/5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/42">
                    {profile?.timezone ?? "n/a"}
                  </span>
                </div>
                <p className="mt-3 max-w-xl text-sm leading-6 text-foreground/65">
                  {profile?.summary?.trim() || "No summary stored yet. The assistant will still use memories, signals, and goals below."}
                </p>
              </div>
              <div className="rounded-3xl bg-white/55 px-4 py-3 text-right ring-1 ring-white/60">
                <div className="text-[10px] uppercase tracking-[0.18em] text-foreground/35">Status</div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {profile ? "Live" : "Empty"}
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat label="Memories" value={snapshot.memories.length} onClick={() => scrollToSection("memory")} />
              <SummaryStat label="Signals" value={snapshot.signals.length} onClick={() => scrollToSection("signals")} />
              <SummaryStat label="Interests" value={snapshot.interests.length} onClick={() => scrollToSection("interests")} />
              <SummaryStat label="Goals" value={activeGoals.length} onClick={() => scrollToSection("goals")} />
            </div>
          </motion.section>

          <motion.section {...sectionMotion} className="glass-card-strong p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Profile Fields</h2>
              <p className="mt-1 text-[11px] leading-5 text-foreground/42">
                Full structured profile data, grouped by how the assistant uses it.
              </p>
            </div>
            <div className="space-y-3">
              {PROFILE_GROUP_META.map((group) => (
                <ProfileGroupCard
                  key={group.key}
                  title={group.title}
                  description={group.description}
                  values={profile?.[group.key] ?? {}}
                  expanded={openGroups[group.key]}
                  onToggle={() => toggleGroup(group.key)}
                />
              ))}
            </div>
          </motion.section>

          <motion.section id="profile-section-memory" {...sectionMotion} className="glass-card-strong p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Memory</h2>
                <p className="mt-1 text-[11px] leading-5 text-foreground/42">
                  Full memory list split into personal entries and event-style records.
                </p>
              </div>
              <div className="rounded-2xl bg-foreground/5 p-1">
                <div className="flex items-center gap-1">
                  {([
                    { id: "entry", label: "Entry", count: entryMemories.length },
                    { id: "event", label: "Event", count: eventMemories.length },
                  ] as const).map((tab) => {
                    const active = memoryTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setMemoryTab(tab.id)}
                        className={`rounded-xl px-3 py-1.5 text-[11px] font-medium transition-colors ${
                          active
                            ? "bg-foreground text-background"
                            : "text-foreground/48 hover:bg-white/45"
                        }`}
                      >
                        {tab.label} ({tab.count})
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-3" style={{ contentVisibility: "auto" }}>
              {visibleMemories.length === 0 ? (
                <EmptyState
                  title={`No ${memoryTab} memories`}
                  description="This tab is empty right now, but the rest of the profile snapshot is still available."
                />
              ) : (
                visibleMemories.map((memory) => (
                  <MemoryItem key={memory.id} memory={memory} />
                ))
              )}
            </div>
          </motion.section>

          <motion.section id="profile-section-signals" {...sectionMotion} className="glass-card-strong p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Signals</h2>
              <p className="mt-1 text-[11px] leading-5 text-foreground/42">
                Recent behavior and context signals the assistant can use for ranking and personalization.
              </p>
            </div>
            <div className="space-y-3" style={{ contentVisibility: "auto" }}>
              {snapshot.signals.length === 0 ? (
                <EmptyState
                  title="No signals yet"
                  description="Signals will appear here when the assistant records behavior or environmental context."
                />
              ) : (
                snapshot.signals.map((signal) => (
                  <SignalItem key={signal.id} signal={signal} />
                ))
              )}
            </div>
          </motion.section>

          <motion.section id="profile-section-interests" {...sectionMotion} className="glass-card-strong p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Interests</h2>
              <p className="mt-1 text-[11px] leading-5 text-foreground/42">
                Derived interests rolled up from signals, with score and confidence shown in full.
              </p>
            </div>
            <div className="space-y-3" style={{ contentVisibility: "auto" }}>
              {snapshot.interests.length === 0 ? (
                <EmptyState
                  title="No interests derived yet"
                  description="Interests will show up after enough signals are collected and summarized."
                />
              ) : (
                snapshot.interests.map((interest) => (
                  <InterestItem key={interest.id} interest={interest} />
                ))
              )}
            </div>
          </motion.section>

          <motion.section id="profile-section-goals" {...sectionMotion} className="glass-card-strong p-4">
            <div className="mb-1 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Goals</h2>
                <p className="mt-1 text-[11px] leading-5 text-foreground/42">
                  Existing active goals stay editable here, now alongside the full profile context above.
                </p>
              </div>
              <button
                onClick={() => setShowAddForm((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-foreground/10"
              >
                <Plus size={14} />
                Add Goal
              </button>
            </div>

            <AnimatePresence initial={false}>
              {showAddForm && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-4 rounded-3xl bg-foreground/[0.03] p-4">
                    <div className="space-y-3">
                      <input
                        value={newKey}
                        onChange={(event) => setNewKey(event.target.value)}
                        placeholder="Key (e.g. learn-spanish)"
                        className="w-full rounded-xl border border-foreground/10 bg-white/65 px-3 py-2 text-xs font-mono text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <input
                        value={newTitle}
                        onChange={(event) => setNewTitle(event.target.value)}
                        placeholder="Title (e.g. Learn conversational Spanish)"
                        className="w-full rounded-xl border border-foreground/10 bg-white/65 px-3 py-2 text-xs text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <div className="flex items-center gap-2">
                        {(["high", "medium", "low"] as const).map((priority) => (
                          <button
                            key={priority}
                            onClick={() => setNewPriority(priority)}
                            className={`flex-1 rounded-xl py-1.5 text-[11px] font-medium transition-colors ${
                              newPriority === priority
                                ? "bg-foreground text-background"
                                : "bg-white/70 text-foreground/50 hover:bg-white"
                            }`}
                          >
                            {priority.charAt(0).toUpperCase() + priority.slice(1)}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowAddForm(false)}
                          className="flex-1 rounded-xl bg-white/70 py-2 text-xs font-medium text-foreground/50 transition-colors hover:bg-white"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleAddGoal}
                          disabled={saving || !newKey.trim() || !newTitle.trim()}
                          className="flex-1 rounded-xl bg-foreground py-2 text-xs font-semibold text-background transition-colors hover:bg-foreground/85 disabled:opacity-40"
                        >
                          {saving ? <Loader2 size={14} className="mx-auto animate-spin" /> : "Add"}
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="mt-4 space-y-2.5">
              {activeGoals.length === 0 ? (
                <EmptyState
                  title="No active goals"
                  description="Add a goal to help the assistant generate more relevant intent cards."
                />
              ) : (
                activeGoals.map((goal, index) => {
                  const meta = goalMeta(goal.key);
                  const Icon = meta.icon;
                  const isExpanded = expandedKey === goal.key;
                  const isClosing = closingKey === goal.key;

                  return (
                    <motion.div
                      key={goal.key}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.04 }}
                    >
                      <div className="glass-card overflow-hidden">
                        <button
                          onClick={() => setExpandedKey(isExpanded ? null : goal.key)}
                          className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-foreground/[0.03]"
                        >
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5">
                            <Icon size={18} strokeWidth={1.5} className="text-foreground/60" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-foreground">
                                {goal.title}
                              </span>
                              <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium text-foreground/42">
                                {goalMeta(goal.key).label}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-[10px] font-mono text-foreground/30">{goal.key}</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                  PRIORITY_STYLE[goal.priority] ?? PRIORITY_STYLE.medium
                                }`}
                              >
                                {goal.priority}
                              </span>
                            </div>
                          </div>
                          <ChevronDown
                            size={14}
                            strokeWidth={1.5}
                            className={`shrink-0 text-foreground/25 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                          />
                        </button>

                        <AnimatePresence initial={false}>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-foreground/8 px-4 pb-4 pt-3">
                                {goal.summary && (
                                  <p className="mb-3 text-[13px] leading-relaxed text-foreground/60">
                                    {goal.summary}
                                  </p>
                                )}
                                <div className="mb-3 text-[11px] text-foreground/38">
                                  Updated {formatDateTime(goal.updated_at)}
                                </div>
                                <button
                                  onClick={() => handleCloseGoal(goal.key)}
                                  disabled={isClosing}
                                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-foreground/5 py-2.5 text-xs font-medium text-foreground/50 transition-colors hover:bg-foreground/10 disabled:opacity-40"
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
                })
              )}
            </div>

            {closedGoals.length > 0 && (
              <div className="mt-6">
                <span className="mb-3 block text-xs font-semibold uppercase tracking-wider text-foreground/25">
                  Closed ({closedGoals.length})
                </span>
                <div className="space-y-1.5">
                  {closedGoals.map((goal) => {
                    const Icon = goalMeta(goal.key).icon;
                    return (
                      <div
                        key={goal.key}
                        className="glass-card flex items-center gap-3 px-4 py-3 opacity-50"
                      >
                        <Icon size={14} strokeWidth={1.5} className="shrink-0 text-foreground/30" />
                        <span className="flex-1 text-xs text-foreground/40 line-through">
                          {goal.title}
                        </span>
                        <X size={10} className="text-foreground/20" />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.section>
        </div>
      )}
    </div>
  );
}
