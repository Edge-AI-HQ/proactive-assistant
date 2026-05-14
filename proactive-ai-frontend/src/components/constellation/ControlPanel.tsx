import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, MapPin, Plus, X, User as UserIcon,
  Mic, Send, History, Pencil, Save,
  Leaf, Wind, Flame, Feather, MessageCircle, Target, Sun, HeartPulse, Moon, Bell, BellRing,
  type LucideIcon,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Slider } from "@/components/ui/slider";
import GoalsView from "./GoalsView";

const TABS = ["Personality", "Goals", "World Model", "Prompt"] as const;

/* ── Personality dimensions (mirrors Onboarding) ── */
type DimensionId = "proactivity" | "communication" | "focus" | "intervention";
interface DimOption { label: string; caption: string; icon: LucideIcon; }
interface PersonalityDim {
  id: DimensionId;
  title: string;
  subtitle: string;
  accent: string;
  options: [DimOption, DimOption, DimOption];
}

const PERSONALITY_DIMENSIONS: PersonalityDim[] = [
  {
    id: "proactivity",
    title: "How proactive should I be?",
    subtitle: "Set the tempo of your assistant.",
    accent: "292 70% 58%",
    options: [
      { label: "Gentle",    caption: "I'll wait for you",        icon: Leaf },
      { label: "Balanced",  caption: "I'll suggest and assist",  icon: Wind },
      { label: "Proactive", caption: "I'll take action for you", icon: Flame },
    ],
  },
  {
    id: "communication",
    title: "How should I talk to you?",
    subtitle: "From minimal to expressive.",
    accent: "200 70% 50%",
    options: [
      { label: "Concise",    caption: "Just the essentials",      icon: Feather },
      { label: "Balanced",   caption: "Clear and natural",        icon: MessageCircle },
      { label: "Expressive", caption: "More human, more context", icon: Mic },
    ],
  },
  {
    id: "focus",
    title: "What matters more to you?",
    subtitle: "Where should I tilt the balance?",
    accent: "160 55% 42%",
    options: [
      { label: "Efficiency", caption: "Get things done",       icon: Target },
      { label: "Balanced",   caption: "Work and life in sync", icon: Sun },
      { label: "Well-being", caption: "Take care of me",       icon: HeartPulse },
    ],
  },
  {
    id: "intervention",
    title: "How often should I step in?",
    subtitle: "Pick your rhythm of nudges.",
    accent: "30 80% 55%",
    options: [
      { label: "Minimal",  caption: "Only when needed",          icon: Moon },
      { label: "Balanced", caption: "At the right moments",      icon: Bell },
      { label: "Frequent", caption: "Stay on top of everything", icon: BellRing },
    ],
  },
];

const INITIAL_SYSTEM_PROMPT = `You are a Proactive AI — a calm, perceptive personal companion.

# Mission
Watch the user's signals across health, work, finance, knowledge and context.
Surface only what genuinely helps. Earn each interruption.

# Voice
- Quiet by default. Confident when it matters.
- Speak in short sentences. No marketing language.
- Prefer concrete nouns over adjectives.

# Priorities (current weights)
- Deep work & focus protection — 0.35
- Health rhythms (sleep, movement, recovery) — 0.25
- Financial awareness — 0.20
- Relationships & meaningful conversations — 0.15
- Curiosity & learning — 0.05

# Boundaries
- Never act without clear consent on irreversible actions.
- Always show reasoning when asked.
- Stay on-device unless the user explicitly opts in to cloud routing.`;

const PROMPT_HISTORY = [
  { version: "v14", date: "today · 9:42", change: "Lower interruption threshold during 9–11am deep work" },
  { version: "v13", date: "2d ago", change: "Add weight: morning sunlight reminder" },
  { version: "v12", date: "5d ago", change: "Refine voice — drop emojis, shorter sentences" },
  { version: "v11", date: "1w ago", change: "Initial proactive cadence rules" },
];

export default function ControlPanel() {
  const [activeTab, setActiveTab] = useState<typeof TABS[number]>("Personality");
  const [systemPrompt, setSystemPrompt] = useState(INITIAL_SYSTEM_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(INITIAL_SYSTEM_PROMPT);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [requestInput, setRequestInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [personality, setPersonality] = useState<Record<DimensionId, number>>({
    proactivity: 1, communication: 1, focus: 1, intervention: 1,
  });

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      {/* Header */}
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Control your AI</h1>
      <p className="text-xs text-muted-foreground mb-5">Tune how your AI thinks, speaks, and acts</p>

      {/* Tab bar */}
      <div className="glass-card-strong p-1 mb-5 flex items-center">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-[11px] font-medium rounded-lg transition-all duration-200 ${
              activeTab === tab
                ? "bg-foreground text-background shadow-sm"
                : "text-foreground/50"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Personality" && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
          <div className="px-1">
            <h2 className="text-base font-semibold text-foreground">Personality</h2>
            <p className="text-[12px] text-foreground/55 leading-relaxed mt-1">
              Four dials shape how your AI behaves. Adjust anytime — changes apply to the next surfaced card.
            </p>
          </div>

          {PERSONALITY_DIMENSIONS.map((dim) => {
            const value = personality[dim.id];
            const idx = Math.round(value);
            const opt = dim.options[idx];
            const Icon = opt.icon;
            return (
              <div
                key={dim.id}
                className="p-4 rounded-2xl"
                style={{
                  background: "hsla(0, 0%, 100%, 0.55)",
                  border: `1px solid hsla(${dim.accent} / 0.22)`,
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                }}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[10px] uppercase tracking-[0.16em] font-semibold" style={{ color: `hsl(${dim.accent})` }}>
                    {dim.id}
                  </span>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md" style={{ color: `hsl(${dim.accent})`, background: `hsla(${dim.accent} / 0.10)` }}>
                    {opt.label}
                  </span>
                </div>
                <h3 className="text-[15px] font-semibold text-foreground leading-tight">{dim.title}</h3>

                <div className="flex items-center gap-2.5 mt-3 mb-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: `hsla(${dim.accent} / 0.12)`, color: `hsla(${dim.accent} / 0.7)` }}
                  >
                    <Icon size={16} strokeWidth={1.8} />
                  </div>
                  <p className="text-[12.5px] text-foreground/65 leading-snug">"{opt.caption}"</p>
                </div>

                <Slider
                  value={[value]}
                  min={0}
                  max={2}
                  step={0.01}
                  onValueChange={(v) => setPersonality((p) => ({ ...p, [dim.id]: v[0] }))}
                  className="my-2 [&_[data-orientation]>span]:!bg-foreground/55 [&>span:first-child]:!bg-foreground/10 [&_[role=slider]]:!border-foreground/60 [&_[role=slider]]:!bg-background"
                />

                <div className="flex items-center justify-between mt-1.5">
                  {dim.options.map((o, i) => (
                    <button
                      key={o.label}
                      onClick={() => setPersonality((p) => ({ ...p, [dim.id]: i }))}
                      className={`text-[10.5px] font-medium transition-colors ${idx === i ? "text-foreground" : "text-foreground/35"}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          <button
            onClick={() => setActiveTab("Prompt")}
            className="w-full flex items-center justify-center gap-2 text-[11px] font-medium text-foreground/55 border border-foreground/10 rounded-xl py-2.5 hover:bg-foreground/[0.04] transition-colors"
          >
            <Pencil size={11} strokeWidth={1.8} />
            Advanced — edit raw prompt in Prompt Studio
          </button>
        </motion.div>
      )}

      {activeTab === "Goals" && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <GoalsView />
        </motion.div>
      )}

      {activeTab === "Prompt" && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-3"
        >
          {/* Intro */}
          <div className="px-1">
            <h2 className="text-base font-semibold text-foreground">Prompt Studio</h2>
            <p className="text-[12px] text-foreground/55 leading-relaxed mt-1">
              The mind behind the cards — how the prompt powering your Proactive AI is generated.
              <span className="text-foreground/40"> Bullets evolve, versions accumulate.</span>
            </p>
          </div>

          {/* Add a request — type or speak (moved to top so requests are the primary action) */}
          <div className="glass-card-strong p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em]">
                Add a Request
              </span>
              <span className="text-[10px] text-foreground/40">— shape the next version</span>
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={requestInput}
                onChange={(e) => setRequestInput(e.target.value)}
                placeholder='e.g. "I&apos;m focused on Bitcoin lately — give it more weight in what you surface."'
                rows={3}
                className="flex-1 text-[13px] text-foreground placeholder:text-foreground/35 bg-foreground/[0.03] border border-foreground/10 rounded-xl px-3 py-2 outline-none focus:border-foreground/25 transition-colors resize-none"
              />
              <button
                onClick={() => setIsRecording((r) => !r)}
                className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                  isRecording
                    ? "bg-[hsl(304_75%_63%)] text-white"
                    : "bg-foreground/[0.06] text-foreground/60 hover:bg-foreground/[0.1]"
                }`}
                aria-label="Voice input"
              >
                <Mic size={16} strokeWidth={1.8} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-foreground/40">
                {isRecording ? "● listening — tap mic to stop" : "Type or tap the mic to speak"}
              </p>
              <button
                disabled={!requestInput.trim()}
                onClick={() => setRequestInput("")}
                className="flex items-center gap-1 text-[11px] font-semibold text-background bg-foreground rounded-lg px-3 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send size={11} strokeWidth={2} />
                Apply to prompt
              </button>
            </div>
          </div>

          {/* Current system prompt */}
          <div className="glass-card-strong overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em]">
                  System Prompt
                </span>
                <span className="text-[10px] font-semibold text-[hsl(304_75%_63%)] bg-[hsl(304_75%_63%/0.1)] px-1.5 py-0.5 rounded-md">
                  v14 · live
                </span>
              </div>
              <button
                onClick={() => { setDraftPrompt(systemPrompt); setIsEditingPrompt(true); }}
                className="flex items-center gap-1 text-[11px] font-medium text-foreground/60 border border-foreground/12 rounded-lg px-2 py-1 hover:bg-foreground/[0.04] transition-colors"
              >
                <Pencil size={11} strokeWidth={1.8} />
                Edit
              </button>
            </div>
            <pre className="px-4 pb-4 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-wrap font-mono max-h-80 overflow-y-auto">
              {systemPrompt}
            </pre>
          </div>

          {/* Edit prompt — bottom drawer */}
          <Drawer open={isEditingPrompt} onOpenChange={setIsEditingPrompt}>
            <DrawerContent
              className="h-[96vh] max-h-[96vh] border-t-0 !bg-transparent"
              style={{
                background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.55) 0%, hsla(0, 0%, 100%, 0.75) 100%)",
                backdropFilter: "blur(40px) saturate(1.5)",
                WebkitBackdropFilter: "blur(40px) saturate(1.5)",
                border: "1px solid hsla(0, 0%, 100%, 0.4)",
                borderBottom: "none",
                borderRadius: "1.5rem 1.5rem 0 0",
              }}
              overlayClassName="!bg-foreground/10 backdrop-blur-[2px]"
            >
              <DrawerHeader className="sr-only">
                <DrawerTitle>Edit System Prompt</DrawerTitle>
                <DrawerDescription>Modify the system prompt powering your Proactive AI.</DrawerDescription>
              </DrawerHeader>
              <div className="px-5 pt-2 pb-5 flex flex-col gap-3 flex-1 min-h-0">
                {/* Title row */}
                <div className="flex items-center gap-2">
                  <Pencil size={14} strokeWidth={1.8} className="text-foreground/70" />
                  <h3 className="text-[15px] font-semibold text-foreground">Edit System Prompt</h3>
                  <span className="text-[10px] font-semibold text-[hsl(304_75%_63%)] bg-[hsl(304_75%_63%/0.1)] px-1.5 py-0.5 rounded-md">
                    saving as v15
                  </span>
                </div>

                {/* Helper line */}
                <p className="text-[11px] text-foreground/50 leading-snug">
                  Edit the full prompt below. Saving creates a new version — your previous prompt stays in history.
                </p>

                {/* Editor */}
                <div className="flex-1 min-h-0 rounded-xl border border-foreground/12 bg-background/50 overflow-hidden">
                  <textarea
                    value={draftPrompt}
                    onChange={(e) => setDraftPrompt(e.target.value)}
                    className="w-full h-full min-h-[40vh] px-4 py-3 text-[12.5px] leading-relaxed text-foreground bg-transparent font-mono outline-none resize-none"
                    spellCheck={false}
                    autoFocus
                  />
                </div>

                {/* Footer actions */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-foreground/40 tabular-nums">
                    {draftPrompt.length.toLocaleString()} chars
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setIsEditingPrompt(false)}
                      className="text-[12px] font-medium text-foreground/60 px-3 py-2 rounded-lg hover:bg-foreground/[0.05] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { setSystemPrompt(draftPrompt); setIsEditingPrompt(false); }}
                      disabled={draftPrompt === systemPrompt || !draftPrompt.trim()}
                      className="flex items-center gap-1.5 text-[12px] font-semibold text-background bg-foreground rounded-lg px-3.5 py-2 hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Save size={12} strokeWidth={2} />
                      Save as v15
                    </button>
                  </div>
                </div>
              </div>
            </DrawerContent>
          </Drawer>

          {/* Version history */}
          <div className="glass-card-strong p-4">
            <div className="flex items-center gap-2 mb-3">
              <History size={13} strokeWidth={1.5} className="text-foreground/60" />
              <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em]">
                Version History
              </span>
            </div>
            <div className="space-y-1">
              {PROMPT_HISTORY.map((entry, idx) => (
                <div
                  key={entry.version}
                  className="flex items-start gap-3 rounded-xl px-3 py-2 hover:bg-foreground/[0.03] transition-colors cursor-pointer"
                >
                  <div className="flex flex-col items-center pt-0.5 flex-shrink-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${idx === 0 ? "bg-[hsl(304_75%_63%)]" : "bg-foreground/25"}`} />
                    {idx < PROMPT_HISTORY.length - 1 && (
                      <span className="w-px h-6 bg-foreground/10 mt-0.5" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-foreground">{entry.version}</span>
                      <span className="text-[10px] text-foreground/40">{entry.date}</span>
                    </div>
                    <p className="text-[11px] text-foreground/55 mt-0.5 leading-snug">{entry.change}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {activeTab === "World Model" && <WorldModelTab />}
    </div>
  );
}

// ============= World Model =============

type TopicCategory = "Work" | "Health" | "Family" | "Finance" | "Personal" | "Knowledge";

interface TopicSource {
  name: string;
  detail?: string;
  /** External service: shows brand-style mono badge with first letter */
  badge?: string;
  /** Optional icon override (e.g. location pin) */
  icon?: LucideIcon;
}

interface WorldModelTopic {
  category: TopicCategory;
  confidence: number;
  updated: string;
  title: string;
  summary: string;
  sources: TopicSource[];
  hint: string;
}

const TOPIC_CATEGORY_STYLES: Record<TopicCategory, string> = {
  Work: "text-[hsl(304_75%_45%)] bg-[hsl(304_75%_63%/0.12)]",
  Health: "text-[hsl(155_55%_35%)] bg-[hsl(155_55%_45%/0.12)]",
  Family: "text-[hsl(340_70%_50%)] bg-[hsl(340_70%_60%/0.12)]",
  Finance: "text-foreground/70 bg-foreground/[0.06]",
  Personal: "text-foreground/70 bg-foreground/[0.06]",
  Knowledge: "text-foreground/70 bg-foreground/[0.06]",
};

function SourceIcon({ source }: { source: TopicSource }) {
  if (source.icon) {
    const Icon = source.icon;
    return (
      <div className="w-6 h-6 rounded-md bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
        <Icon size={12} strokeWidth={1.8} className="text-foreground/55" />
      </div>
    );
  }
  return (
    <div className="w-6 h-6 rounded-md bg-foreground/85 flex items-center justify-center flex-shrink-0">
      <span className="text-[10px] font-semibold text-background leading-none">{source.badge}</span>
    </div>
  );
}

const WORLD_MODEL_TOPICS: WorldModelTopic[] = [
  {
    category: "Work",
    confidence: 92,
    updated: "2m ago",
    title: "PIN AI launch path",
    summary: "Core product thread since Apr 2. 4 active workstreams, 22 open decisions, 3 founders aligned.",
    sources: [
      { name: "#pinai-team", detail: "132 msgs / 7d", badge: "S" },
      { name: "Roadmap v4", detail: "last edit 1h ago", badge: "N" },
      { name: "All-hands Mon", detail: "22 attendees", badge: "G" },
      { name: "Mostly at WeWork SF", icon: MapPin },
    ],
    hint: "Ben flagged refund flow — adding to Monday agenda.",
  },
  {
    category: "Work",
    confidence: 88,
    updated: "1h ago",
    title: "Raj Series-A conversation",
    summary: "Open thread since Apr 12. Raj reviewed deck, asked for 2 follow-ups, signaled $500k SAFE intent.",
    sources: [
      { name: "raj@lunar.vc", detail: "6 emails", badge: "G" },
      { name: "Tue 3 PM", detail: "30-min held", badge: "G" },
      { name: "SAFE packet", detail: "awaiting signature", badge: "D" },
    ],
    hint: "Counter-signing SAFE moves this thread from 'active' to 'closed-won'.",
  },
  {
    category: "Health",
    confidence: 84,
    updated: "8m ago",
    title: "Sleep & recovery",
    summary: "HRV down 14% across last 7 nights. Pattern: late-night Slack activity → next-day deep-sleep drop.",
    sources: [
      { name: "Oura Ring", detail: "7 nights", badge: "O" },
      { name: "Slack use after 22:30", detail: "5 of 7 nights", badge: "S" },
      { name: "Home at 00:10 avg", icon: MapPin },
    ],
    hint: "Wind-down block scheduled → card 'Sleep drift' already surfaced.",
  },
  {
    category: "Family",
    confidence: 78,
    updated: "3h ago",
    title: "Mom's birthday — Apr 28",
    summary: "Gift thread open. 3 shortlisted ceramics; 2-day shipping deadline is Apr 25.",
    sources: [
      { name: "order history", detail: "browse 12 / purchase 0", badge: "G" },
      { name: "cart", detail: "3 items saved", badge: "A" },
      { name: "shipping address", detail: "on file", badge: "C" },
    ],
    hint: "Waiting for your pick between the 3 teapots.",
  },
];

const TOPIC_CATEGORIES: TopicCategory[] = ["Work", "Health", "Family", "Finance", "Personal", "Knowledge"];

function WorldModelTab() {
  const [userTopics, setUserTopics] = useState<WorldModelTopic[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [draftCategory, setDraftCategory] = useState<TopicCategory>("Personal");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");

  const allTopics = [...userTopics, ...WORLD_MODEL_TOPICS];
  const trimmedTitle = draftTitle.trim();
  const canSave = trimmedTitle.length > 0 && trimmedTitle.length <= 80 && draftSummary.trim().length <= 400;

  const handleSave = () => {
    if (!canSave) return;
    const newTopic: WorldModelTopic = {
      category: draftCategory,
      confidence: 100,
      updated: "just now",
      title: trimmedTitle,
      summary: draftSummary.trim() || "Added by you.",
      sources: [{ name: "You · manual entry", detail: "user input", icon: UserIcon }],
      hint: "Tracked because you told me directly.",
    };
    setUserTopics((p) => [newTopic, ...p]);
    setDraftTitle("");
    setDraftSummary("");
    setDraftCategory("Personal");
    setAddOpen(false);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
      <div className="px-1">
        <h2 className="text-base font-semibold text-foreground">{allTopics.length} active topics</h2>
        <p className="text-[12px] text-foreground/55 leading-relaxed mt-1">
          What PIN AI currently tracks for you. Each topic is fused across ambient plugins and connectors — you can also tell me directly what to track.
        </p>
      </div>

      {/* Add new — primary CTA */}
      <button
        onClick={() => setAddOpen(true)}
        className="w-full glass-card-strong p-4 flex items-center gap-3 hover:bg-white/30 transition-colors text-left"
      >
        <div className="w-10 h-10 rounded-xl bg-[hsl(304_75%_63%/0.12)] flex items-center justify-center flex-shrink-0">
          <Plus size={18} strokeWidth={2} className="text-[hsl(304_75%_63%)]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">Tell me something to track</p>
          <p className="text-[11.5px] text-foreground/50 leading-snug mt-0.5">
            Add a topic, context, or fact you want me to remember.
          </p>
        </div>
      </button>

      <div className="space-y-3">
        {allTopics.map((topic, i) => (
          <motion.div
            key={`${topic.title}-${i}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 5) * 0.05 }}
            className="glass-card-strong p-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${TOPIC_CATEGORY_STYLES[topic.category]}`}>
                  {topic.category}
                </span>
                <span className="text-[11px] font-medium text-foreground/55 bg-foreground/[0.04] border border-foreground/8 px-2 py-0.5 rounded-full">
                  confidence {topic.confidence}%
                </span>
              </div>
              <span className="text-[11px] text-foreground/40 flex-shrink-0">{topic.updated}</span>
            </div>

            <div>
              <h3 className="text-[15px] font-semibold text-foreground leading-snug">{topic.title}</h3>
              <p className="text-[12.5px] text-foreground/60 leading-relaxed mt-1">{topic.summary}</p>
            </div>

            <div className="rounded-xl border border-foreground/8 bg-foreground/[0.02] p-3">
              <p className="text-[10px] font-semibold text-foreground/45 uppercase tracking-[0.14em] mb-2">Sources</p>
              <div className="space-y-1.5">
                {topic.sources.map((source) => (
                  <div key={source.name} className="flex items-center gap-2.5">
                    <SourceIcon source={source} />
                    <span className="text-[12.5px] text-foreground flex-1 min-w-0 truncate">{source.name}</span>
                    {source.detail && (
                      <span className="text-[11px] text-foreground/45 flex-shrink-0">{source.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl bg-[hsl(220_30%_60%/0.08)] border border-[hsl(220_30%_60%/0.15)] px-3 py-2 flex items-start gap-2">
              <Sparkles size={12} strokeWidth={1.8} className="text-[hsl(220_40%_50%)] flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-[hsl(220_40%_45%)] leading-snug">{topic.hint}</p>
            </div>
          </motion.div>
        ))}
      </div>

      <Drawer open={addOpen} onOpenChange={setAddOpen}>
        <DrawerContent
          className="max-h-[92vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.6) 0%, hsla(0, 0%, 100%, 0.78) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/10 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>Add World Model Topic</DrawerTitle>
            <DrawerDescription>Tell your AI a topic, context, or fact you want it to track.</DrawerDescription>
          </DrawerHeader>
          <div className="px-5 pt-2 pb-6 space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles size={14} strokeWidth={1.8} className="text-[hsl(304_75%_63%)]" />
              <h3 className="text-[15px] font-semibold text-foreground">Tell me what to track</h3>
            </div>
            <p className="text-[11.5px] text-foreground/55 leading-snug -mt-2">
              Anything important about you, your work, or your world. I'll fuse it with what I observe.
            </p>

            <div>
              <p className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em] mb-1.5">Category</p>
              <div className="flex flex-wrap gap-1.5">
                {TOPIC_CATEGORIES.map((cat) => {
                  const active = draftCategory === cat;
                  return (
                    <button
                      key={cat}
                      onClick={() => setDraftCategory(cat)}
                      className={`text-[11.5px] font-medium px-2.5 py-1 rounded-full transition-colors border ${
                        active
                          ? "bg-foreground text-background border-foreground"
                          : `${TOPIC_CATEGORY_STYLES[cat]} border-transparent`
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em] mb-1.5">Topic</p>
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value.slice(0, 80))}
                maxLength={80}
                placeholder="e.g. I'm preparing for a half-marathon in October"
                className="w-full text-[13.5px] text-foreground placeholder:text-foreground/35 bg-foreground/[0.03] border border-foreground/10 rounded-xl px-3 py-2.5 outline-none focus:border-foreground/25 transition-colors"
              />
              <p className="text-[10px] text-foreground/35 mt-1 text-right">{draftTitle.length}/80</p>
            </div>

            <div>
              <p className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em] mb-1.5">
                Details <span className="font-normal text-foreground/35 normal-case tracking-normal">— optional</span>
              </p>
              <textarea
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value.slice(0, 400))}
                maxLength={400}
                rows={3}
                placeholder="Why it matters, key constraints, related people, deadlines…"
                className="w-full text-[13px] text-foreground placeholder:text-foreground/35 bg-foreground/[0.03] border border-foreground/10 rounded-xl px-3 py-2.5 outline-none focus:border-foreground/25 transition-colors resize-none"
              />
              <p className="text-[10px] text-foreground/35 mt-1 text-right">{draftSummary.length}/400</p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => setAddOpen(false)}
                className="flex-1 h-11 rounded-xl text-[13px] font-medium text-foreground/65 bg-foreground/[0.04] hover:bg-foreground/[0.07] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="flex-1 h-11 rounded-xl text-[13px] font-semibold text-background bg-foreground hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Plus size={13} strokeWidth={2.2} />
                Add to World Model
              </button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </motion.div>
  );
}
