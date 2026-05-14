import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Send, Loader2, ChevronUp, Zap, Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles, Mic, X, Pause, Play, Pencil, MessageSquarePlus, ThumbsUp, ThumbsDown, Mail, Calendar, Globe, FileSearch, Settings, Hand, Database, FileText, Bell, DollarSign, Users, MessageSquare, Search, Brain, Lock, type LucideIcon } from "lucide-react";
import { DrawerDetailBody } from "./CardDrawerDetail";

/* --------- Tool icon registry: brand logos when available, else mono icons --------- */
export type ToolIcon =
  | { kind: "brand"; name: "gmail" | "gcal" | "gdrive" | "gdocs" | "gsheets" | "slack" | "notion" | "linear" }
  | { kind: "mono"; Icon: LucideIcon };

export function brandSvg(name: string): JSX.Element | null {
  switch (name) {
    case "gmail":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <path fill="#4285f4" d="M44 11.11v25.78c0 .98-.8 1.78-1.78 1.78H38V17.5L24 28 10 17.5V38.67H5.78C4.8 38.67 4 37.87 4 36.89V11.11c0-.98.8-1.78 1.78-1.78H7L24 22l17-12.67h1.22c.98 0 1.78.8 1.78 1.78z"/>
          <path fill="#34a853" d="M10 38.67V17.5l14 10.5z"/>
          <path fill="#fbbc04" d="M38 17.5v21.17h4.22c.98 0 1.78-.8 1.78-1.78V11.11z"/>
          <path fill="#ea4335" d="M38 17.5L24 28 10 17.5V11.11L24 21.5l14-10.39z"/>
          <path fill="#c5221f" d="M10 11.11V17.5l-6-4.5v-1.89c0-.98.8-1.78 1.78-1.78H7z"/>
        </svg>
      );
    case "gcal":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="6" y="8" width="36" height="34" rx="3" fill="#fff" stroke="#dadce0"/>
          <rect x="6" y="8" width="36" height="8" rx="3" fill="#1a73e8"/>
          <text x="24" y="33" textAnchor="middle" fontSize="14" fontWeight="700" fill="#1a73e8" fontFamily="system-ui">31</text>
        </svg>
      );
    case "gdrive":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <path fill="#0066da" d="M8 36l4 7h24l-4-7z"/>
          <path fill="#00ac47" d="M20 5L8 26l4 7 12-21z"/>
          <path fill="#ea4335" d="M28 5l12 21-4 7L24 12z"/>
          <path fill="#ffba00" d="M20 5h8l12 21H16z"/>
        </svg>
      );
    case "gdocs":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="10" y="6" width="28" height="36" rx="2" fill="#4285f4"/>
          <rect x="15" y="16" width="18" height="2" fill="#fff"/>
          <rect x="15" y="21" width="18" height="2" fill="#fff"/>
          <rect x="15" y="26" width="18" height="2" fill="#fff"/>
          <rect x="15" y="31" width="12" height="2" fill="#fff"/>
        </svg>
      );
    case "gsheets":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="10" y="6" width="28" height="36" rx="2" fill="#0f9d58"/>
          <rect x="15" y="16" width="18" height="20" fill="#fff"/>
          <path d="M15 22h18M15 28h18M22 16v20M29 16v20" stroke="#0f9d58" strokeWidth="1"/>
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <path fill="#36c5f0" d="M14 28a4 4 0 100 8 4 4 0 000-8zm0-2h4v-8h-4a4 4 0 100 8z"/>
          <path fill="#2eb67d" d="M20 14a4 4 0 108 0 4 4 0 00-8 0zm2 0v4h8v-4a4 4 0 10-8 0z" transform="translate(-2 0)"/>
          <path fill="#ecb22e" d="M34 20a4 4 0 100 8 4 4 0 000-8zm-2 0h-4v8h4a4 4 0 100-8z"/>
          <path fill="#e01e5a" d="M28 34a4 4 0 10-8 0 4 4 0 008 0zm-2 0v-4h-8v4a4 4 0 108 0z"/>
        </svg>
      );
    case "notion":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="8" y="6" width="32" height="36" rx="3" fill="#fff" stroke="#000" strokeWidth="1.5"/>
          <path d="M16 14v20M32 14l-12 16V14" stroke="#000" strokeWidth="2.2" fill="none" strokeLinecap="round"/>
        </svg>
      );
    case "linear":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <circle cx="24" cy="24" r="18" fill="#5e6ad2"/>
        </svg>
      );
  }
  return null;
}

export function detectToolIcon(text: string): ToolIcon {
  const t = text.toLowerCase();
  if (/(gmail|email|sending email|searching emails|inbox|reply)/.test(t)) return { kind: "brand", name: "gmail" };
  if (/(calendar|appointment|schedule|meeting|reminder)/.test(t)) return { kind: "brand", name: "gcal" };
  if (/(slack|channel|message)/.test(t)) return { kind: "brand", name: "slack" };
  if (/(notion)/.test(t)) return { kind: "brand", name: "notion" };
  if (/(linear|issue|ticket)/.test(t)) return { kind: "brand", name: "linear" };
  if (/(drive|upload|download|file)/.test(t)) return { kind: "brand", name: "gdrive" };
  if (/(doc|draft|document)/.test(t)) return { kind: "brand", name: "gdocs" };
  if (/(sheet|spreadsheet|table)/.test(t)) return { kind: "brand", name: "gsheets" };
  if (/(web|search.*web|browse|website|http)/.test(t)) return { kind: "mono", Icon: Globe };
  if (/(memor|recall|history)/.test(t)) return { kind: "mono", Icon: FileSearch };
  if (/(approv|waiting|requesting)/.test(t)) return { kind: "mono", Icon: Hand };
  if (/(payment|invoice|cost|budget)/.test(t)) return { kind: "mono", Icon: DollarSign };
  if (/(team|people|contact)/.test(t)) return { kind: "mono", Icon: Users };
  if (/(notif|alert|flag)/.test(t)) return { kind: "mono", Icon: Bell };
  if (/(query|database|sql)/.test(t)) return { kind: "mono", Icon: Database };
  if (/(plan|re-plan|finalizing|preparing|drafting|incorporating|context|setting|configur)/.test(t)) return { kind: "mono", Icon: Settings };
  if (/(search|find|look|cross-check|validating)/.test(t)) return { kind: "mono", Icon: Search };
  if (/(think|reason|analy)/.test(t)) return { kind: "mono", Icon: Brain };
  return { kind: "mono", Icon: Sparkles };
}

export function ToolIconBadge({ icon, isDone }: { icon: ToolIcon; isDone: boolean }) {
  return (
    <div className="relative shrink-0" style={{ width: 36, height: 36 }}>
      <div
        className="w-9 h-9 rounded-[10px] flex items-center justify-center overflow-hidden border border-foreground/10"
        style={{ background: icon.kind === "brand" ? "#fff" : "rgba(255,255,255,0.85)" }}
      >
        {icon.kind === "brand" ? (
          <div className="w-6 h-6">{brandSvg(icon.name)}</div>
        ) : (
          <icon.Icon size={16} strokeWidth={1.8} className="text-foreground/75" />
        )}
      </div>
      {/* status dot */}
      <div
        className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full flex items-center justify-center border-2 border-white"
        style={{ background: isDone ? "rgb(34,197,94)" : "rgba(255,255,255,0.95)" }}
      >
        {isDone ? (
          <Check size={8} className="text-white" strokeWidth={4} />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-foreground/30" />
        )}
      </div>
    </div>
  );
}
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";

export interface Artifact {
  kind: "email" | "notes" | "message" | "doc";
  app: "gmail" | "slack" | "notion" | "gdocs";
  title: string;
  meta?: string;
  body: string;
}

export interface ChatCard {
  id: number;
  category: string;
  tag?: string;
  complexity?: "simple"; // marks quick-approve tasks (low risk, few steps)
  title: string;
  line1: string;
  line2: string;
  detail?: {
    scores: { label: string; value: number }[];
    willExecute: string;
    executionPlan: { text: string; tool: string }[];
    dataSources: string[];
    impact: string;
    permissions: string;
    result?: string;
    artifacts?: Artifact[];
  };
}

interface ChatDetailViewProps {
  card: ChatCard;
  onBack: () => void;
  mode?: "confirm" | "modify" | "done" | "steer";
}

interface ChatMessage {
  id: string;
  sender: "ai" | "user";
  type: "text" | "action" | "card-ref";
  content: string;
  status?: "done" | "running";
  timestamp: string;
}

/* User replies per card id */
const USER_REPLIES: Record<number, string[]> = {
  7: ["Got it, please send the payment confirmation to Alex ASAP", "Also CC Sarah on the reply"],
  1: ["Interesting, can you summarize the key capability differences?", "Share this with the product team too"],
  2: ["Thanks, remind me 30 min before", "Pull up last meeting notes with Rai"],
  3: ["Looks correct, same as last month", "Log it and move on"],
  4: ["Let me review the numbers first before approving", "What's the current total allocation?"],
  5: ["Add the new hire update to the agenda", "Make sure everyone has the Notion link"],
  6: ["Should I adjust my workout schedule?", "Show me the weekly trend comparison"],
  8: ["Confirm the appointment", "What's the best route from the office?"],
  9: ["This is a big deal for our positioning", "Set up a strategy discussion for Thursday"],
  10: ["Approve the Claude access for the team", "How much does that add to our monthly cost?"],
  11: ["Pull the latest action items from last meeting", "I'll draft the update now"],
  12: ["How does this affect our token timeline?", "Flag this for the next board meeting"],
};

/* Generate fake timestamps based on card id */
function getTimestamps(cardId: number) {
  const baseHour = 9 + (cardId % 8);
  const baseMin = (cardId * 7) % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const times: string[] = [];
  let h = baseHour, m = baseMin;
  for (let i = 0; i < 10; i++) {
    times.push(`${pad(h)}:${pad(m)}`);
    m += 1 + (i % 3);
    if (m >= 60) { m -= 60; h += 1; }
  }
  return times;
}

/* Split a step content into a short title + descriptive sentence */
function splitTitleDesc(content: string): { title: string; desc: string | null } {
  // pattern A: "Preparing · Gmail" → title "Preparing", desc "Gmail"
  const dot = content.indexOf(" · ");
  if (dot > -1) {
    return { title: content.slice(0, dot), desc: content.slice(dot + 3) };
  }
  // pattern B: long sentence → title = first 3 words, desc = full
  const words = content.split(/\s+/);
  if (words.length > 6) {
    return { title: words.slice(0, 3).join(" "), desc: content };
  }
  return { title: content, desc: null };
}

/* Stable, memoized execution panel — prevents flicker from parent re-renders */
const ActionRow = memo(function ActionRow({ msg, isPaused, isLast }: { msg: ChatMessage; isPaused: boolean; isLast: boolean }) {
  const isDone = msg.status === "done";
  const icon = useMemo(() => detectToolIcon(msg.content), [msg.content]);
  const { title, desc } = useMemo(() => splitTitleDesc(msg.content), [msg.content]);
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
      className="flex items-start gap-3 pl-1 pr-2 relative"
    >
      {/* Timeline rail behind icons */}
      {!isLast && (
        <span
          aria-hidden
          className="absolute left-[19px] top-9 bottom-[-12px] w-px bg-foreground/12"
        />
      )}
      <div className="relative z-10">
        {isDone ? (
          <ToolIconBadge icon={icon} isDone />
        ) : (
          <div className="relative shrink-0" style={{ width: 36, height: 36 }}>
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-white border border-foreground/10 overflow-hidden">
              {icon.kind === "brand" ? (
                <div className="w-6 h-6 opacity-90">{brandSvg(icon.name)}</div>
              ) : (
                <icon.Icon size={16} strokeWidth={1.8} className="text-foreground/75" />
              )}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full bg-white border-2 border-white flex items-center justify-center">
              <Loader2 size={10} className={`text-amber-500 ${isPaused ? "opacity-50" : "animate-spin"}`} />
            </div>
          </div>
        )}
      </div>
      <div className={`flex-1 min-w-0 pt-1 ${desc ? "pb-4" : "pb-5"}`}>
        <div className="flex items-baseline justify-between gap-2">
          <p className={`text-[13.5px] font-semibold leading-tight ${isDone ? "text-foreground/85" : "text-foreground"}`}>
            {title}
          </p>
          <span className="text-[11px] text-foreground/40 shrink-0 tabular-nums">&lt;1s</span>
        </div>
        {desc && (
          <p className={`text-[12.5px] leading-snug mt-1.5 ${isDone ? "text-foreground/55" : "text-foreground/75"}`}>
            {desc}
          </p>
        )}
      </div>
    </motion.div>
  );
});

const ActionPanel = memo(function ActionPanel({ items, label, isPaused }: { items: ChatMessage[]; label: string; isPaused: boolean }) {
  if (items.length === 0) return null;
  const doneCount = items.filter(m => m.status === "done").length;
  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.32, ease: [0.32, 0.72, 0, 1] } }}
      className="rounded-2xl border border-foreground/8 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.45)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
    >
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">{label}</p>
        <p className="text-[11px] text-foreground/40">{doneCount} / {items.length}</p>
      </div>
      <div className="px-3 pb-2 pt-1">
        {items.map((msg, i) => (
          <ActionRow key={msg.id} msg={msg} isPaused={isPaused} isLast={i === items.length - 1} />
        ))}
      </div>
    </motion.div>
  );
});

/* ── Artifact panel: shows generated drafts (emails / notes / messages) ── */
const ARTIFACT_KIND_LABEL: Record<Artifact["kind"], string> = {
  email: "Email draft",
  notes: "Notes",
  message: "Message draft",
  doc: "Document",
};

export function ArtifactItem({ artifact, index, locked = false }: { artifact: Artifact; index: number; locked?: boolean }) {
  const [expanded, setExpanded] = useState(index === 0);
  const brand = artifact.app === "gmail" ? "gmail"
    : artifact.app === "slack" ? "slack"
    : artifact.app === "notion" ? "notion"
    : "gdocs";
  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.28, ease: [0.32, 0.72, 0, 1] } }}
      className="rounded-xl border border-foreground/8 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.65)" }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-white border border-foreground/10 flex items-center justify-center shrink-0 overflow-hidden">
          <div className="w-5 h-5">{brandSvg(brand)}</div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground/40 leading-none mb-1">
            {ARTIFACT_KIND_LABEL[artifact.kind]}
          </p>
          <p className="text-[13px] font-semibold text-foreground/85 truncate leading-tight">{artifact.title}</p>
          {artifact.meta && (
            <p className="text-[11px] text-foreground/45 mt-0.5 truncate">{artifact.meta}</p>
          )}
        </div>
        <ChevronUp
          size={14}
          strokeWidth={2}
          className={`text-foreground/35 shrink-0 transition-transform duration-300 ${expanded ? "" : "rotate-180"}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 pt-0.5 border-t border-foreground/[0.06] relative">
              {locked ? (
                <div className="relative pt-2.5">
                  <p className="text-[12.5px] text-foreground/75 leading-relaxed whitespace-pre-line">
                    {artifact.body.slice(0, Math.floor(artifact.body.length / 2))}
                  </p>
                  <div className="relative mt-1">
                    <p
                      className="text-[12.5px] text-foreground/75 leading-relaxed whitespace-pre-line select-none pointer-events-none"
                      style={{ filter: "blur(5px)" }}
                      aria-hidden="true"
                    >
                      {artifact.body.slice(Math.floor(artifact.body.length / 2))}
                    </p>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex items-center justify-center w-7 h-7 rounded-full bg-foreground/85 text-background shadow-sm">
                        <Lock size={12} strokeWidth={2.5} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-[12.5px] text-foreground/75 leading-relaxed whitespace-pre-line pt-2.5">
                  {artifact.body}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const ArtifactPanel = memo(function ArtifactPanel({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts || artifacts.length === 0) return null;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
      className="rounded-2xl border border-foreground/8 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.45)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
    >
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">
          {artifacts.length === 1 ? "Generated draft" : "Generated drafts"}
        </p>
        <p className="text-[11px] text-foreground/40">{artifacts.length}</p>
      </div>
      <div className="px-3 pb-3 pt-1 flex flex-col gap-2">
        {artifacts.map((a, i) => (
          <ArtifactItem key={i} artifact={a} index={i} />
        ))}
      </div>
    </motion.div>
  );
});

/* Build the structured "Needs your input" questions. The number of questions
   (1–3) is deterministic per card and matches the pink action-count badge.
   First option in each question is the implicit default (auto-selected),
   but no "Default" label is shown to the user. */
interface InputOption { label: string }
interface InputQuestion { id: string; question: string; options: InputOption[] }

// Mirror of getActionCount in ChatTimeline — keeps the question count in sync
// with the pink badge number on the chat list.
function getQuestionCount(cardId: number): number {
  return ((cardId * 7 + 2) % 3) + 1;
}

function buildInputQuestions(card: ChatCard): InputQuestion[] {
  const firstStep = card.detail?.executionPlan[0]?.text || card.title;
  const pool: InputQuestion[] = [
    {
      id: "scope",
      question: `Confirm the scope — proceed with "${firstStep}"?`,
      options: [
        { label: "Yes, proceed as planned" },
        { label: "Run a quick dry-run first" },
        { label: "Narrow to the essentials only" },
      ],
    },
    {
      id: "timing",
      question: "When should I run this?",
      options: [
        { label: "Right now" },
        { label: "In 15 minutes" },
        { label: "Schedule for tomorrow 9am" },
      ],
    },
    {
      id: "extras",
      question: "Anything to skip or add before I run?",
      options: [
        { label: "Nothing — keep as is" },
        { label: "Also notify the team channel" },
        { label: "Skip notifications, just draft" },
      ],
    },
  ];
  const count = Math.max(1, Math.min(3, getQuestionCount(card.id)));
  return pool.slice(0, count);
}


export default function ChatDetailView({ card, onBack, mode = "confirm" }: ChatDetailViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [cardDrawerOpen, setCardDrawerOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [pulseColorIndex, setPulseColorIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = isPaused; }, [isPaused]);
  // Set true when the user takes over (Steer-send) so the initial tick() stops emitting.
  const initialCancelledRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(() => {
    setIsListening(true);
    setVoiceTranscript("");
    setPulseColorIndex(Math.floor(Math.random() * 5));

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      // No API support — still show voice UI with a message
      setVoiceTranscript("Speech recognition not supported in this browser");
      return;
    }
    try {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "zh-CN";
      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setVoiceTranscript(transcript);
        setInputValue(transcript);
      };
      recognition.onerror = (e: any) => {
        console.log("Speech recognition error:", e.error);
        setVoiceTranscript("Listening...");
      };
      recognition.onend = () => {
        recognitionRef.current = null;
      };
      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.log("Speech recognition failed to start:", err);
      setVoiceTranscript("Could not start speech recognition");
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Task lifecycle: running → needs-input (pause for question) → running → done
  const [taskState, setTaskState] = useState<"running" | "needs-input" | "done" | "dismissed">("running");
  const [showInput, setShowInput] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Structured "Needs your input" Q&A — questions are interleaved into execution.
  const inputQuestions = useMemo(() => buildInputQuestions(card), [card]);
  const inputQuestionsRef = useRef(inputQuestions);
  useEffect(() => { inputQuestionsRef.current = inputQuestions; }, [inputQuestions]);
  // Index of the question currently being asked (null when none active).
  const [activeQuestionIndex, setActiveQuestionIndex] = useState<number | null>(null);
  const [selectedOption, setSelectedOption] = useState<number>(0);
  const [committedAnswers, setCommittedAnswers] = useState<{ q: string; a: string }[]>([]);

  // Refs to drive the interleaved execution + question queue
  const queueRef = useRef<Array<
    | { kind: "action"; content: string; final: boolean }
    | { kind: "question"; questionIndex: number }
  >>([]);
  const idxRef = useRef(0);
  const tickRef = useRef<() => void>(() => {});
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const timers: NodeJS.Timeout[] = [];
    const ts = getTimestamps(card.id);
    let ti = 0;
    initialCancelledRef.current = false;

    // 1. Card reference (clickable)
    setMessages([{
      id: "card-ref",
      sender: "ai",
      type: "card-ref",
      content: card.title,
      timestamp: ts[ti++],
    }]);

    if (!card.detail) return;
    const plan = card.detail.executionPlan;

    if (mode === "steer") {
      // Steer mode: don't auto-execute. Just show context (card-ref) and open
      // the input bar so the user can type guidance before anything runs.
      // Sending input will trigger handleSendInput → AI follow-up flow.
      initialCancelledRef.current = true;
      setShowInput(true);
      setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }

    if (mode === "done") {
      // Done flow: show all messages instantly (pure execution log)
      const allMessages: ChatMessage[] = [{
        id: "card-ref", sender: "ai", type: "card-ref",
        content: card.title, timestamp: ts[ti++],
      }];
      plan.forEach((step, i) => {
        allMessages.push({
          id: `action-${i}`, sender: "ai", type: "action",
          content: step.text, status: "done",
          timestamp: ts[ti++] || ts[ts.length - 1],
        });
      });
      allMessages.push({
        id: "summary", sender: "ai", type: "text",
        content: `${card.detail!.result || `${card.detail!.willExecute}.`}\n\nLet me know if anything needs adjusting, or close to return home.`,
        timestamp: ts[ti++] || ts[ts.length - 1],
      });
      setMessages(allMessages);
      return;
    }

    // ── Build interleaved queue: actions + questions inserted between steps ──
    type Step =
      | { kind: "action"; content: string; final: boolean }
      | { kind: "question"; questionIndex: number };

    const numQuestions = inputQuestionsRef.current.length;
    const SUB_PREFIXES = ["Preparing", "Querying", "Validating", "Cross-checking", "Drafting", "Finalizing"];

    // Compute, for each question, which plan-step index it should appear AFTER.
    // Distribute questions evenly across the plan. Never after the very last step
    // (questions belong mid-execution, not after everything finishes).
    const insertAfter = new Set<number>();
    if (plan.length > 0 && numQuestions > 0) {
      // Slots: positions 1..plan.length-1 (insert after these step indices)
      // If plan has only 1 step, fall back to inserting after step 0.
      const maxSlot = Math.max(0, plan.length - 1);
      const slots: number[] = [];
      if (maxSlot === 0) {
        for (let i = 0; i < numQuestions; i++) slots.push(0);
      } else {
        for (let q = 0; q < numQuestions; q++) {
          // Even distribution across [0..maxSlot-1] → after step idx in [0..maxSlot-1]
          const idx = Math.floor(((q + 1) * maxSlot) / (numQuestions + 1));
          slots.push(Math.max(0, Math.min(maxSlot - 1, idx)));
        }
      }
      slots.forEach((s) => insertAfter.add(s));
    }

    const queue: Step[] = [];
    let qCounter = 0;
    plan.forEach((step, i) => {
      const subA = SUB_PREFIXES[(i * 2) % SUB_PREFIXES.length];
      const subB = SUB_PREFIXES[(i * 2 + 1) % SUB_PREFIXES.length];
      const shortLabel = step.text.length > 60 ? step.text.slice(0, 58) + "…" : step.text;
      queue.push({ kind: "action", content: `${subA} · ${step.tool}`, final: false });
      queue.push({ kind: "action", content: `${subB} context for "${shortLabel}"`, final: false });
      queue.push({ kind: "action", content: step.text, final: i === plan.length - 1 });
      if (insertAfter.has(i) && qCounter < numQuestions) {
        queue.push({ kind: "question", questionIndex: qCounter });
        qCounter++;
      }
    });
    // Safety: any remaining questions append before summary
    while (qCounter < numQuestions) {
      queue.push({ kind: "question", questionIndex: qCounter });
      qCounter++;
    }

    queueRef.current = queue;
    idxRef.current = 0;

    let timer: NodeJS.Timeout | null = null;

    const tick = () => {
      if (cancelledRef.current) return;
      if (initialCancelledRef.current) {
        setMessages(prev => prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m));
        return;
      }
      if (pausedRef.current) {
        timer = setTimeout(tick, 250);
        return;
      }
      if (idxRef.current >= queueRef.current.length) {
        // All actions + questions consumed → emit summary
        setMessages(prev => {
          const cleared = prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m);
          return [...cleared, {
            id: "summary", sender: "ai", type: "text",
            content: `${card.detail!.result || `${card.detail!.willExecute}.`}\n\nLet me know if anything needs adjusting, or close to return home.`,
            timestamp: ts[ti++] || ts[ts.length - 1],
          }];
        });
        return;
      }
      const step = queueRef.current[idxRef.current++];

      if (step.kind === "question") {
        // Pause execution: surface the question, wait for Approve.
        setMessages(prev => prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m));
        setActiveQuestionIndex(step.questionIndex);
        setSelectedOption(0);
        setTaskState("needs-input");
        return;
      }

      // action
      setMessages(prev => {
        const updated = prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m);
        return [...updated, {
          id: `action-${idxRef.current}`, sender: "ai", type: "action",
          content: step.content,
          status: "running",
          timestamp: ts[ti++] || ts[ts.length - 1],
        }];
      });
      const isFinal = step.final;
      timer = setTimeout(() => {
        if (cancelledRef.current) return;
        setMessages(prev => prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m));
        tick();
      }, isFinal ? 700 : 600);
    };

    tickRef.current = tick;
    timer = setTimeout(tick, 600);

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
      timers.forEach(clearTimeout);
    };
  }, [card, mode]);

  const sources = card.line2
    .replace("Sources:", "")
    .replace("Sources: ", "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);

  // Derive task state from messages
  const actionMessages = useMemo(() => messages.filter(m => m.type === "action"), [messages]);
  const totalSteps = card.detail?.executionPlan.length || 0;
  const completedSteps = actionMessages.filter(m => m.status === "done").length;
  const isRunning = actionMessages.some(m => m.status === "running");
  const summaryMsg = messages.find(m => m.id === "summary");
  const askMsg = messages.find(m => m.id === "ai-ask");
  const isDone = !!summaryMsg && !isRunning;
  useEffect(() => {
    if (taskState === "dismissed") return;
    if (taskState === "needs-input") return;
    if (isDone) {
      if (taskState !== "done") setTaskState("done");
      return;
    }
    if (taskState === "done") return;
    if (isRunning && taskState !== "running") setTaskState("running");
  }, [isRunning, isDone, taskState]);

  // Approve handler: commits the active question's selection, then resumes execution.
  const handleApprove = () => {
    if (taskState !== "needs-input" || activeQuestionIndex === null) {
      // Fallback: nothing to approve, just resume.
      tickRef.current();
      return;
    }
    const currentQ = inputQuestionsRef.current[activeQuestionIndex];
    if (!currentQ) {
      setActiveQuestionIndex(null);
      setTaskState("running");
      tickRef.current();
      return;
    }
    const chosen = currentQ.options[selectedOption] || currentQ.options[0];
    setCommittedAnswers(prev => [...prev, { q: currentQ.question, a: chosen.label }]);
    setActiveQuestionIndex(null);
    setSelectedOption(0);
    setTaskState("running");
    // Resume the queue
    setTimeout(() => tickRef.current(), 250);
  };
  const handleDismiss = () => { setTaskState("dismissed"); setTimeout(onBack, 250); };
  const handlePauseToggle = () => setIsPaused(p => !p);
  const handleSteer = () => {
    setShowInput(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // User send: post their message, then have AI auto-continue with new steps
  const followUpSeq = useRef(0);
  const handleSendInput = () => {
    const text = inputValue.trim();
    if (!text) return;
    setInputValue("");
    const seq = ++followUpSeq.current;
    const ts = getTimestamps(card.id);
    const baseTi = (ts.length - 1 + seq * 4) % ts.length;
    const stamp = (off: number) => ts[(baseTi + off) % ts.length];

    // Comment mode: when the task is already done, the input was opened via the
    // "Comment" button — treat the message as feedback only. No re-execution.
    // Use a distinct id prefix so the bubble is NOT picked up by the user-input
    // chronological renderer (which would place it above the Result panel).
    if (taskState === "done") {
      setMessages(prev => [
        ...prev.filter(m => m.id !== "comment-ack" && !m.id.startsWith("comment-")),
        { id: `comment-${seq}`, sender: "user", type: "text", content: text, timestamp: stamp(0) },
      ]);
      setShowInput(false);
      setTimeout(() => {
        setMessages(prev => [
          ...prev,
          {
            id: "comment-ack",
            sender: "ai",
            type: "text",
            content: "Got your comment — I'll use it to improve next time. Thanks for the feedback.",
            timestamp: stamp(1),
          },
        ]);
      }, 350);
      return;
    }

    // Stop the initial execution queue & freeze any in-flight running rows
    initialCancelledRef.current = true;

    // 1. Show user bubble, freeze any running initial rows, and drop any existing summary
    setMessages(prev => [
      ...prev
        .filter(m => m.id !== "summary")
        .map(m => (m.status === "running" && !m.id.startsWith("followup-")) ? { ...m, status: "done" as const } : m),
      { id: `user-input-${seq}`, sender: "user", type: "text", content: text, timestamp: stamp(0) },
    ]);

    // Resume / kick into running so toolbar shows Pause and state-sync stays correct
    if (isPaused) setIsPaused(false);
    setTaskState("running");

    // Pause-aware scheduler
    const runWhenLive = (fn: () => void, ms: number) => {
      const tryRun = () => {
        if (pausedRef.current) setTimeout(tryRun, 250);
        else fn();
      };
      setTimeout(tryRun, ms);
    };

    // 2. Generate fresh execution steps under the user's message
    const SUB_PREFIXES = ["Re-planning", "Querying", "Validating", "Drafting", "Finalizing"];
    const shortText = text.length > 38 ? text.slice(0, 38) + "…" : text;
    const newSteps: string[] = [
      `${SUB_PREFIXES[0]} based on your input`,
      `Incorporating "${shortText}"`,
      `${SUB_PREFIXES[2]} updated context`,
      `${SUB_PREFIXES[3]} revised output`,
    ];

    const stepGap = 750;
    let delay = 450;

    newSteps.forEach((content, i) => {
      const id = `followup-${seq}-${i}`;
      const off = i + 1;
      runWhenLive(() => {
        setMessages(prev => {
          const cleared = prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m);
          return [...cleared, {
            id, sender: "ai", type: "action",
            content, status: "running", timestamp: stamp(off),
          }];
        });
      }, delay);
      delay += stepGap;
    });

    // 3. Append summary → triggers state-sync to flip taskState to "done"
    runWhenLive(() => {
      setMessages(prev => {
        const cleared = prev.map(m => m.status === "running" ? { ...m, status: "done" as const } : m);
        const planSummary = card.detail?.willExecute || card.line1;
        return [...cleared.filter(m => m.id !== "summary"), {
          id: "summary", sender: "ai", type: "text",
          content: `Done — incorporated your input "${text.length > 60 ? text.slice(0, 60) + "…" : text}".\n\n${planSummary}`,
          timestamp: stamp(newSteps.length + 1),
        }];
      });
    }, delay + 250);
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="px-4 pt-14 pb-3 border-b border-foreground/8">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded-full hover:bg-foreground/8 transition-colors text-foreground/50 shrink-0"
          >
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-foreground/40">Task</span>
              {totalSteps > 0 && (
                <span className="text-[10px] text-foreground/40">· {completedSteps}/{totalSteps}</span>
              )}
              {taskState === "running" && !isPaused && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600">
                  <Loader2 size={9} className="animate-spin" /> running
                </span>
              )}
              {taskState === "running" && isPaused && (
                <span className="text-[10px] font-semibold text-foreground/55">paused</span>
              )}
              {taskState === "needs-input" && (
                <span className="text-[10px] font-semibold text-[hsl(292,78%,63%)]">needs you</span>
              )}
              {taskState === "done" && (
                <span className="text-[10px] font-semibold text-green-600">done</span>
              )}
            </div>
            <h2 className="text-[15px] text-foreground font-semibold leading-snug truncate">
              {card.title}
            </h2>
          </div>
        </div>
      </div>

      {/* Task body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {/* Card reference summary — opens drawer. Shows brief task summary + simplified plan */}
        <button
          onClick={() => setCardDrawerOpen(true)}
          className="w-full rounded-2xl px-4 py-3 border border-foreground/8 text-left group"
          style={{
            background: "rgba(255,255,255,0.5)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
          }}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40 mb-1">Context</p>
              <p className="text-[13px] text-foreground/80 leading-relaxed line-clamp-2">
                {card.detail?.willExecute || card.line1}
              </p>
              {card.detail?.executionPlan && card.detail.executionPlan.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {card.detail.executionPlan.slice(0, 3).map((step, i) => {
                    const icon = detectToolIcon(step.text + " " + step.tool);
                    return (
                      <div key={i} className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-4 h-4 rounded-[5px] flex items-center justify-center overflow-hidden border border-foreground/10 shrink-0"
                          style={{ background: icon.kind === "brand" ? "#fff" : "rgba(255,255,255,0.85)" }}
                        >
                          {icon.kind === "brand" ? (
                            <div className="w-[11px] h-[11px]">{brandSvg(icon.name)}</div>
                          ) : (
                            <icon.Icon size={9} strokeWidth={2} className="text-foreground/70" />
                          )}
                        </span>
                        <span className="text-[11.5px] text-foreground/60 truncate leading-snug">{step.text}</span>
                      </div>
                    );
                  })}
                  {card.detail.executionPlan.length > 3 && (
                    <span className="text-[10.5px] text-foreground/40 pl-[22px]">
                      +{card.detail.executionPlan.length - 3} more
                    </span>
                  )}
                </div>
              )}
            </div>
            <ChevronUp size={13} className="text-foreground/30 group-hover:text-foreground/60 transition-colors shrink-0 mt-0.5" />
          </div>
        </button>

        {/* Chronological render: initial actions → (user bubble + followup actions)* → needs-input → summary */}
        {(() => {
          const userBubbles = messages.filter(m => m.id.startsWith("user-input-"));
          // Once a follow-up exists, freeze the initial Execution panel as fully done.
          const hasFollowup = userBubbles.length > 0;
          const initialActionsRaw = actionMessages.filter(m => !m.id.startsWith("followup-"));
          const initialActions = hasFollowup
            ? initialActionsRaw.map(m => m.status === "running" ? { ...m, status: "done" as const } : m)
            : initialActionsRaw;

          return (
            <>
              <ActionPanel items={initialActions} label="Execution" isPaused={isPaused} />
              {userBubbles.map((bubble, bi) => {
                const seq = bubble.id.replace("user-input-", "");
                const followupsRaw = actionMessages.filter(m => m.id.startsWith(`followup-${seq}-`));
                // Freeze earlier follow-up panels too once a newer user bubble exists
                const isLast = bi === userBubbles.length - 1;
                const followups = isLast
                  ? followupsRaw
                  : followupsRaw.map(m => m.status === "running" ? { ...m, status: "done" as const } : m);
                return (
                  <div key={bubble.id} className="space-y-3">
                    <motion.div
                      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                      className="flex justify-end"
                    >
                      <div className="max-w-[82%] px-3.5 py-2 rounded-[16px] rounded-br-[4px] bg-foreground text-background text-[13px] leading-relaxed shadow-sm">
                        {bubble.content}
                      </div>
                    </motion.div>
                    <ActionPanel items={followups} label="Continued" isPaused={isPaused} />
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* Generated drafts — appears below execution once the task finishes */}
        {isDone && card.detail?.artifacts && card.detail.artifacts.length > 0 && (
          <ArtifactPanel artifacts={card.detail.artifacts} />
        )}

        {/* Needs-input prompt — appears beneath the execution panel when a question is queued */}
        <AnimatePresence initial={false}>
          {taskState === "needs-input" && activeQuestionIndex !== null && (() => {
            const currentQ = inputQuestions[activeQuestionIndex];
            if (!currentQ) return null;
            return (
              <motion.div
                key={`q-${activeQuestionIndex}`}
                layout
                initial={{ opacity: 0, y: 10, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.985 }}
                transition={{ duration: 0.36, ease: [0.32, 0.72, 0, 1] }}
                className="rounded-2xl px-4 py-3.5 border border-[hsl(292,78%,63%)]/35 overflow-hidden bg-background/60"
              >
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-1.5">
                    <motion.span
                      className="inline-block rounded-full bg-[hsl(292,78%,63%)]"
                      style={{ width: 8, height: 8 }}
                      animate={{ opacity: [0.55, 1, 0.55], scale: [1, 1.15, 1] }}
                      transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                    />
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[hsl(292,78%,55%)]">
                      Needs your input
                    </p>
                  </div>
                  <span className="text-[10px] font-semibold text-foreground/40 tabular-nums">
                    {activeQuestionIndex + 1} / {inputQuestions.length}
                  </span>
                </div>

                {/* Current question */}
                <p className="text-[13.5px] text-foreground/85 font-semibold leading-snug mb-2.5">
                  {currentQ.question}
                </p>

                {/* Options as selectable chips */}
                <div className="space-y-1.5">
                  {currentQ.options.map((opt, i) => {
                    const isSelected = i === selectedOption;
                    return (
                      <button
                        key={i}
                        onClick={() => setSelectedOption(i)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left text-[13px] border"
                        style={{
                          background: isSelected ? "hsl(0 0% 0% / 0.04)" : "rgba(255,255,255,0.5)",
                          borderColor: isSelected ? "hsl(0 0% 0% / 0.55)" : "hsl(0 0% 0% / 0.08)",
                          transition: "background 240ms ease, border-color 240ms ease",
                        }}
                      >
                        <span className={`flex-1 transition-colors duration-200 ${isSelected ? "text-foreground font-medium" : "text-foreground/70"}`}>
                          {opt.label}
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <span
                            className="w-4 h-4 rounded-full border flex items-center justify-center"
                            style={{
                              borderColor: isSelected ? "hsl(0 0% 0%)" : "hsl(0 0% 0% / 0.18)",
                              background: isSelected ? "hsl(0 0% 0%)" : "transparent",
                              transition: "background 240ms ease, border-color 240ms ease",
                            }}
                          >
                            {isSelected && <Check size={10} strokeWidth={3} className="text-white" />}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <p className="mt-3 text-[11px] text-foreground/45 leading-relaxed">
                  Tap Continue to apply your choice and resume execution.
                </p>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* Summary */}
        {summaryMsg && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl px-4 py-3 border border-pink-200/40"
            style={{ background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.03) 100%)" }}
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap size={12} className="text-[hsl(292,78%,63%)]" strokeWidth={2.2} />
              <p className="text-[11px] font-bold uppercase tracking-wider bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">Result</p>
            </div>
            <p className="text-[13px] text-foreground/80 leading-relaxed whitespace-pre-line">{summaryMsg.content}</p>
          </motion.div>
        )}

        {/* Comment thread — user feedback after task is done. Always rendered
            below the Result so the order is: Result → user comment → ack. */}
        {(() => {
          const commentBubbles = messages.filter(m => m.id.startsWith("comment-") && m.id !== "comment-ack");
          const ack = messages.find(m => m.id === "comment-ack");
          if (commentBubbles.length === 0 && !ack) return null;
          return (
            <div className="space-y-3">
              {commentBubbles.map((b) => (
                <motion.div
                  key={b.id}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                  className="flex justify-end"
                >
                  <div className="max-w-[82%] px-3.5 py-2 rounded-[16px] rounded-br-[4px] bg-foreground text-background text-[13px] leading-relaxed shadow-sm">
                    {b.content}
                  </div>
                </motion.div>
              ))}
              {ack && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="rounded-2xl px-4 py-3 border border-foreground/8"
                  style={{ background: "rgba(255,255,255,0.5)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
                >
                  <p className="text-[13px] text-foreground/75 leading-relaxed">{ack.content}</p>
                </motion.div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Voice mode overlay */}
      <AnimatePresence>
        {isListening && (
          <>
          <motion.div
            key="voice-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={stopListening}
            className="absolute inset-0 z-20"
            style={{
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              background: "rgba(0,0,0,0.05)",
            }}
          />
          <motion.div
            key="voice-overlay"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
            className="absolute bottom-0 left-0 right-0 z-30 flex flex-col items-center justify-center"
            style={{
              height: "33vh",
              background: "rgba(255,255,255,0.7)",
              backdropFilter: "blur(32px) saturate(1.4)",
              WebkitBackdropFilter: "blur(32px) saturate(1.4)",
              borderRadius: "2rem 2rem 0 0",
              borderBottom: "1px solid rgba(255,255,255,0.4)",
              borderLeft: "1px solid rgba(255,255,255,0.3)",
              borderRight: "1px solid rgba(255,255,255,0.3)",
            }}
          >
            {/* Pulsing mic — colorful rings */}
            <div className="relative flex items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
              {(() => {
                const palettes = [
                  ["rgba(225,92,230,0.4)", "rgba(139,92,246,0.35)", "rgba(59,130,246,0.28)"],
                  ["rgba(251,146,60,0.4)", "rgba(244,63,94,0.35)", "rgba(168,85,247,0.28)"],
                  ["rgba(52,211,153,0.4)", "rgba(59,130,246,0.35)", "rgba(139,92,246,0.28)"],
                  ["rgba(244,63,94,0.4)", "rgba(251,146,60,0.35)", "rgba(234,179,8,0.28)"],
                  ["rgba(99,102,241,0.4)", "rgba(225,92,230,0.35)", "rgba(244,63,94,0.28)"],
                ];
                const colors = palettes[pulseColorIndex % palettes.length];
                return (
                  <>
                    <motion.div
                      className="absolute rounded-full"
                      style={{ width: 80, height: 80, background: colors[0] }}
                      animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                    />
                    <motion.div
                      className="absolute rounded-full"
                      style={{ width: 80, height: 80, background: colors[1] }}
                      animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.35 }}
                    />
                    <motion.div
                      className="absolute rounded-full"
                      style={{ width: 80, height: 80, background: colors[2] }}
                      animate={{ scale: [1, 1.25, 1], opacity: [0.4, 0, 0.4] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.7 }}
                    />
                  </>
                );
              })()}
              <button
                onClick={stopListening}
                className="relative rounded-full bg-foreground flex items-center justify-center text-background shadow-xl"
                style={{ width: 60, height: 60 }}
              >
                <Mic size={22} strokeWidth={1.8} />
              </button>
            </div>
            <p className="text-[14px] text-foreground/60 min-h-[22px] font-medium mb-5 px-8 text-center">
              {voiceTranscript || "Listening..."}
            </p>
            <div className="flex items-center gap-4">
              <button
                onClick={stopListening}
                className="text-[13px] text-foreground/60 hover:text-foreground/80 transition-colors flex items-center gap-1.5 px-5 py-1.5 rounded-full border border-foreground/12 bg-foreground/5"
              >
                <X size={13} strokeWidth={2} /> Cancel
              </button>
              <button
                onClick={stopListening}
                className="flex items-center gap-1.5 px-5 py-1.5 rounded-full bg-foreground text-background text-[13px] font-medium hover:bg-foreground/80 transition-colors"
              >
                <Check size={13} strokeWidth={2.5} /> Done
              </button>
            </div>
          </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Action toolbar — varies by task state */}
      {taskState !== "dismissed" && (actionMessages.length > 0 || summaryMsg || askMsg) && (
        <div className="px-4 pt-2">
          {taskState === "done" ? (
            // Done: feedback only
            <div
              className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl border border-foreground/8"
              style={{ background: "rgba(255,255,255,0.5)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
            >
              <span className="text-[12px] text-foreground/55 font-medium">Was this helpful?</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setFeedback("up")}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${feedback === "up" ? "bg-green-500/20 text-green-600" : "bg-foreground/5 text-foreground/55 hover:bg-foreground/10"}`}
                  aria-label="Helpful"
                >
                  <ThumbsUp size={13} strokeWidth={2} />
                </button>
                <button
                  onClick={() => setFeedback("down")}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${feedback === "down" ? "bg-red-500/20 text-red-600" : "bg-foreground/5 text-foreground/55 hover:bg-foreground/10"}`}
                  aria-label="Not helpful"
                >
                  <ThumbsDown size={13} strokeWidth={2} />
                </button>
                <button
                  onClick={handleSteer}
                  className="ml-1 flex items-center gap-1.5 px-3 h-8 rounded-full bg-foreground/5 hover:bg-foreground/10 transition-colors text-[12px] font-medium text-foreground/65"
                >
                  <MessageSquarePlus size={12} strokeWidth={2} /> Comment
                </button>
              </div>
            </div>
          ) : (
            // Running or needs-input: Dismiss / Steer / (Pause | Approve)
            <div className="flex items-center gap-2">
              <button
                onClick={handleDismiss}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
              >
                <X size={13} strokeWidth={2} /> Dismiss
              </button>
              <button
                onClick={handleSteer}
                className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[12px] font-medium text-foreground/55"
                title="Steer this task"
              >
                <Pencil size={11} strokeWidth={2} /> Steer
              </button>
              {taskState === "running" ? (
                <button
                  onClick={handlePauseToggle}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold text-background transition-colors"
                  style={{ background: isPaused ? "hsl(var(--foreground))" : "linear-gradient(135deg, hsl(292 78% 63%), hsl(330 80% 65%))" }}
                >
                  {isPaused ? (<><Play size={13} strokeWidth={2.2} fill="currentColor" /> Resume</>) : (<><Pause size={13} strokeWidth={2.2} /> Pause</>)}
                </button>
              ) : (
                <button
                  onClick={handleApprove}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors"
                >
                  {taskState === "needs-input" ? (
                    <><Check size={13} strokeWidth={2.5} /> Continue</>
                  ) : (
                    <><Check size={13} strokeWidth={2.5} /> Approve</>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Input bar — hidden by default, shown when Steer is clicked */}
      <AnimatePresence initial={false}>
        {showInput && (
          <motion.div
            key="input-bar"
            initial={{ opacity: 0, y: 16, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: 16, height: 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="px-4 pb-6 pt-2.5 overflow-hidden"
          >
            <div
              className="px-4 py-3 flex items-center gap-3 rounded-2xl border border-foreground/10"
              style={{
                background: "rgba(255,255,255,0.6)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
              }}
            >
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSendInput(); } }}
                placeholder="Steer the task — type your guidance..."
                className="flex-1 bg-transparent text-[15px] text-foreground placeholder:text-foreground/35 outline-none"
              />
              <button
                onClick={startListening}
                className="w-8 h-8 rounded-full bg-foreground/10 flex items-center justify-center text-foreground/60 hover:bg-foreground/15 hover:text-foreground transition-colors"
                aria-label="Voice input"
              >
                <Mic size={17} strokeWidth={2} />
              </button>
              <button
                onClick={handleSendInput}
                disabled={!inputValue.trim()}
                className="w-8 h-8 rounded-full bg-foreground flex items-center justify-center text-background hover:bg-foreground/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                <Send size={15} strokeWidth={2} />
              </button>
              <button
                onClick={() => setShowInput(false)}
                className="w-8 h-8 rounded-full bg-foreground/5 flex items-center justify-center text-foreground/45 hover:bg-foreground/10 transition-colors"
                aria-label="Hide input"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          </motion.div>
        )}
        {!showInput && (
          <div key="bottom-spacer" className="pb-5" />
        )}
      </AnimatePresence>


      {/* Card content drawer — same layout as home card detail, no buttons */}
      <Drawer open={cardDrawerOpen} onOpenChange={setCardDrawerOpen}>
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
            <DrawerTitle>{card.title}</DrawerTitle>
            <DrawerDescription>Card detail view</DrawerDescription>
          </DrawerHeader>
          <ChatCardDrawerBody card={card} sources={sources} />
        </DrawerContent>
      </Drawer>
    </div>
  );
}

const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth: { icon: Sprout, label: "Growth" },
  work: { icon: Briefcase, label: "Work" },
  finance: { icon: TrendingUp, label: "Finance" },
  health: { icon: Heart, label: "Health" },
  learn: { icon: BookOpen, label: "Learn" },
  life: { icon: Sparkles, label: "Life" },
};

/* Drawer body — mirrors home CardDrawerContent (no action buttons) */
function ChatCardDrawerBody({ card }: { card: ChatCard; sources: string[] }) {
  const cat = CATEGORIES[card.category];
  const Icon = cat?.icon || Briefcase;

  return (
    <div className="px-5 pb-5 pt-1.5 overflow-y-auto max-h-[75vh]">
      {/* Category + tag + Quick badge */}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{cat?.label || card.category}</span>
        {card.tag && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
            {card.tag}
          </span>
        )}
        {card.complexity === "simple" && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: "rgba(225,92,230,0.12)", color: "#E15CE6" }}
            title="Low-risk task — usually safe to approve as-is"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#E15CE6" }} />
            Quick approve
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-[18px] leading-snug text-foreground mb-1.5 font-semibold">{card.title}</h3>

      {/* Concise "what to do" summary */}
      <p className="text-[13.5px] text-foreground/55 leading-snug mb-3">
        {card.detail?.willExecute || card.line1}
      </p>

      {card.detail && <DrawerDetailBody card={card} />}
    </div>
  );
}

