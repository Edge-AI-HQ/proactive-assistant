import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Loader2, ChevronUp, Zap, Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles, X, Pause, Play, MessageSquarePlus, ThumbsUp, ThumbsDown, Mail, Calendar, Globe, FileSearch, Settings, Hand, Database, FileText, Bell, DollarSign, Users, MessageSquare, Search, Brain, Lock, type LucideIcon } from "lucide-react";
import { VoiceButton } from "@/components/voice";
import { DrawerDetailBody, executeArtifactToLovable } from "./CardDrawerDetail";
import BrowserPanel from "../browser-view/BrowserPanel";
import type { SheetStage } from "../browser-view/BrowserView";
import { useBrowserSession } from "@/hooks/useBrowserSession";
import {
  useCardExecutionRun,
  type LastMessagePayload,
  type PendingInput,
  type RunSnapshot,
  type SideEffect,
  type SSEEvent,
} from "@/hooks/useCardExecutionRun";

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
  /** Generator-side rationale; rendered as a dedicated "WHY NOW" block
   *  in the chat-side drawer mirror (ChatCardDrawerBody). */
  whyNow?: string;
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
  /**
   * Card-execute run id. Optional only to keep alternate Lovable demo
   * layouts (AppLayout / BigBallLayout) type-checking; production
   * always passes a real run id from ConstellationLayout.
   */
  runId?: string;
  onBack: () => void;
  /**
   * Called when the user starts a /retry. Parent should swap runId to the
   * returned new run id. If omitted, retry is hidden.
   */
  onRetry?: (newRunId: string) => void;
  /**
   * Bootstrap HumanMessage to fire automatically if the card's
   * chat-thread is empty on mount. Mirrors upstream's CardChat
   * `bootstrapMessage` semantic: the home Drawer's Confirm button
   * passes the card's `primaryAction.label` here so opening a freshly
   * generated card (whose fan-out missed) still kicks the agent off
   * the same way the user clicking Confirm always has.
   */
  bootstrap?: string;
  /**
   * Legacy: the prior mock-driven implementation accepted "confirm" /
   * "modify" / "done" / "steer" to seed different initial UI. The new
   * SSE-driven flow derives all of that from `runId` snapshot so this
   * prop is accepted (for backward compat with alternate-layout entry
   * points) and ignored.
   */
  mode?: "confirm" | "modify" | "done" | "steer";
  /**
   * Backend feedback hook for the top-toolbar Dismiss button. The hook's
   * `run.cancel()` is local-only (just flips UI state); this callback
   * mirrors the home drawer's Dismiss path so the card POSTs
   * /feedback kind=dismiss, drops out of the sphere, and shows as
   * Dismissed in the TASKS view. Parent wires this to
   * `cardActions.dismiss(realIntentCard)`.
   */
  onDismissBackend?: () => void;
  /**
   * Backend feedback hook for the top-toolbar Done button. Same shape
   * as `onDismissBackend` — POSTs /feedback kind=card_action
   * action=complete so the card moves from sphere → TASKS as Completed.
   */
  onDoneBackend?: () => void;
}

interface ChatMessage {
  id: string;
  sender: "ai" | "user";
  type: "text" | "action" | "card-ref";
  content: string;
  status?: "done" | "running";
  timestamp: string;
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

/* Collapsible wrapper around ActionPanel.
 *
 * Owns its own `expanded` state so the user can toggle freely, but
 * auto-resyncs whenever `defaultCollapsed` flips — typically when the
 * run transitions between running ↔ paused ↔ done. The header shows
 * a compact summary (N steps + state badge) so the user can scan
 * progress without expanding. */
function CollapsibleActionGroup({
  items, label, isPaused, defaultCollapsed,
}: {
  items: ChatMessage[];
  label: string;
  isPaused: boolean;
  defaultCollapsed: boolean;
}) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  useEffect(() => {
    setExpanded(!defaultCollapsed);
  }, [defaultCollapsed]);

  if (items.length === 0) return null;
  const doneCount = items.filter((m) => m.status === "done").length;
  const runningCount = items.filter((m) => m.status === "running").length;
  const stateLabel =
    runningCount > 0
      ? `${doneCount}/${items.length} · running`
      : `${doneCount}/${items.length} · done`;

  return (
    <div
      className="rounded-2xl border border-foreground/8 overflow-hidden"
      style={{
        background: "rgba(255,255,255,0.45)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-foreground/[0.02] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/45">
            {label}
          </span>
          <span className="text-[11px] text-foreground/40">· {stateLabel}</span>
        </div>
        <ChevronUp
          size={14}
          strokeWidth={2}
          className={`text-foreground/35 transition-transform ${expanded ? "" : "rotate-180"}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-foreground/[0.06]">
          <ActionPanel items={items} label={label} isPaused={isPaused} />
        </div>
      )}
    </div>
  );
}

/* ActionPanel renders just the timeline rows. The outer surface
 * (rounded background + collapsible header) lives in
 * `CollapsibleActionGroup` — this stays a thin body so it works as a
 * standalone block in tests / storybook scenarios. */
const ActionPanel = memo(function ActionPanel({ items, isPaused }: { items: ChatMessage[]; label: string; isPaused: boolean }) {
  if (items.length === 0) return null;
  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.32, ease: [0.32, 0.72, 0, 1] } }}
      className="px-3 pb-2 pt-1"
    >
      {items.map((msg, i) => (
        <ActionRow key={msg.id} msg={msg} isPaused={isPaused} isLast={i === items.length - 1} />
      ))}
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

/* Heuristic match: artifact.kind → side_effect.slug prefix. Used in the
 * Result panel to upgrade "Email draft" to "Email · Sent" when the
 * corresponding dangerous_write actually fired. v1 limitation: if an
 * agent emits multiple artifacts of the same kind, all match the first
 * matching side_effect — acceptable since multi-artifact-same-kind is
 * rare for current card patterns. */
export function matchSideEffect(
  artifact: Artifact,
  sideEffects: SideEffect[],
): SideEffect | null {
  if (artifact.kind === "email") {
    return sideEffects.find((s) => s.slug.startsWith("GMAIL_")) ?? null;
  }
  if (artifact.kind === "message") {
    return sideEffects.find((s) => s.slug.startsWith("SLACK_")) ?? null;
  }
  if (artifact.kind === "doc") {
    return (
      sideEffects.find((s) =>
        s.slug.startsWith("NOTION_") ||
        s.slug.startsWith("GDOCS_") ||
        s.slug.startsWith("GDRIVE_"),
      ) ?? null
    );
  }
  return null;
}

/* Verb mapping for the upgraded label (e.g. "Email · Sent"). */
const SIDE_EFFECT_VERB: Record<Artifact["app"], string> = {
  gmail: "Sent",
  slack: "Posted",
  notion: "Created",
  gdocs: "Created",
};

/* Extract a generic URL from opaque output_meta. Returns the first of
 * url / permalink / web_link found as a string; null otherwise. */
function urlFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["url", "permalink", "web_link"] as const) {
    const v = m[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function ArtifactItem({
  artifact, index, locked = false, sideEffect = null,
}: {
  artifact: Artifact;
  index: number;
  locked?: boolean;
  sideEffect?: SideEffect | null;
}) {
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
          {(() => {
            // Label upgrade: "Email draft" → "Email · Sent" / "Email · Failed"
            // when a matching side_effect proves the action fired.
            if (!sideEffect) {
              return (
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground/40 leading-none mb-1">
                  {ARTIFACT_KIND_LABEL[artifact.kind]}
                </p>
              );
            }
            if (sideEffect.is_error) {
              return (
                <p className="text-[10px] font-semibold uppercase tracking-wider text-red-600 leading-none mb-1">
                  {ARTIFACT_KIND_LABEL[artifact.kind]} · Failed
                </p>
              );
            }
            return (
              <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700 leading-none mb-1">
                {ARTIFACT_KIND_LABEL[artifact.kind]} · {SIDE_EFFECT_VERB[artifact.app]}
              </p>
            );
          })()}
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
              {sideEffect && !sideEffect.is_error && (() => {
                const url = urlFromMeta(sideEffect.output_meta);
                if (!url) return null;
                return (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-[12px] font-medium text-foreground/70 hover:text-foreground transition-colors"
                  >
                    Open ↗
                  </a>
                );
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* StaticPauseCard — read-only chat exchange for a past
 * `input_required` event. The active pause (with chips + input +
 * Continue) is rendered separately by the main component; this is
 * for historical pauses the user has already replied to, so they
 * stay visible in the chat scrollback the same way past messages
 * stay visible in any chat app.
 *
 * Visually: agent's outgoing `message` text at top + the chip options
 * the agent offered at that turn (read-only pills) + the user's
 * actual reply (right-aligned bubble) at the bottom. Everything
 * structured-payload-y (plan, drafts, dangerous_actions, risks) is
 * intentionally NOT replayed in the scrollback — those were shown
 * live during the active pause and the most current drafts always
 * sit in the top-pinned drafts card. The scrollback is just
 * conversation: "agent said X, offered these shortcuts, user replied
 * Y".
 */
function StaticPauseCard({
  index, total, data, userReply,
}: {
  index: number;
  total: number;
  data: PendingInput | undefined;
  userReply: string | null;
}) {
  const agentText = data?.kind === "message" ? (data.message ?? "") : "";
  const options: string[] = data?.kind === "message" ? (data.options ?? []) : [];
  if (!agentText && !userReply && options.length === 0) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
      className="rounded-2xl px-4 py-3 border border-foreground/10 bg-background/40"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-foreground/40">
          Agent
        </p>
        {total > 1 && (
          <span className="text-[10px] font-semibold text-foreground/35 tabular-nums">
            {index} / {total}
          </span>
        )}
      </div>
      {agentText && (
        <p className="text-[13px] text-foreground/75 leading-snug whitespace-pre-line">
          {agentText}
        </p>
      )}
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((label, i) => (
            <span
              key={i}
              className="text-[11.5px] px-2.5 py-1 rounded-full border border-foreground/10 text-foreground/55"
              style={{ background: "rgba(255,255,255,0.4)" }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
      {userReply && (
        <div className="mt-2.5 flex justify-end">
          <div className="max-w-[82%] px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-foreground text-background text-[12.5px] leading-relaxed shadow-sm">
            {userReply}
          </div>
        </div>
      )}
    </motion.div>
  );
}

/* ContinueReplyBox — the persistent input slot shown beneath the Result
 * card while the run is in pending_done. Lets the user keep talking to
 * the agent (`continueWith` spawns a fresh run carrying the typed text
 * as continuation context). The task ends only when the user clicks
 * Done in the top toolbar — exactly like a chat where the conversation
 * stays open until the user closes it. */
function ContinueReplyBox({
  busy, value, onChange, onSubmit,
}: {
  busy: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void | Promise<void>;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
      className="rounded-2xl px-4 py-3 border border-foreground/10 bg-background/50"
    >
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-foreground/40 mb-2">
        Keep going
      </p>
      <div
        className="px-3 py-2 rounded-xl border border-foreground/10 flex items-center gap-2"
        style={{ background: "rgba(255,255,255,0.55)" }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void onSubmit();
            }
          }}
          placeholder="Reply to keep the conversation going..."
          className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 outline-none"
        />
        <VoiceButton onUpdate={onChange} />
      </div>
      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={busy || !value.trim()}
        className="mt-3 w-full px-4 py-2.5 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        {busy ? (
          <><Loader2 size={13} className="animate-spin" /> Sending…</>
        ) : (
          <>Continue <ArrowRight size={13} strokeWidth={2.5} /></>
        )}
      </button>
    </motion.div>
  );
}

/* ArtifactPanel — the draft / generated-content card.
 *
 * Collapsible: the user can fold it once they've reviewed the content.
 * When `version` increments (e.g. the agent re-called `send_message`
 * with a new draft), the card automatically re-expands and the header
 * label flips to "Updated draft" so the change is visible at a glance.
 *
 * `version` is the FE's view of `messageCount` from the hook: 0 before
 * any pause, 1 on the initial plan introduction, 2+ on each subsequent
 * re-call.
 * Auto-re-expand is keyed off `version` changes via a useEffect so user
 * folds are respected between updates. */
const ArtifactPanel = memo(function ArtifactPanel({
  artifacts, sideEffects = [], version = 1,
}: {
  artifacts: Artifact[];
  sideEffects?: SideEffect[];
  version?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  // When a new approval version lands, re-open the card so the user
  // sees the change. Manual folds in between are preserved.
  useEffect(() => {
    setExpanded(true);
  }, [version]);

  if (!artifacts || artifacts.length === 0) return null;
  const isUpdate = version >= 2;
  const headerLabel = isUpdate
    ? artifacts.length === 1 ? "Updated draft" : "Updated drafts"
    : artifacts.length === 1 ? "Generated draft" : "Generated drafts";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
      className="rounded-2xl border border-foreground/8 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.45)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 pt-3 pb-2 flex items-center justify-between hover:bg-foreground/[0.02] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">
            {headerLabel}
          </p>
          {isUpdate && (
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{
                color: "hsl(292 78% 45%)",
                background: "hsl(292 78% 63% / 0.12)",
              }}
            >
              v{version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <p className="text-[11px] text-foreground/40">{artifacts.length}</p>
          <ChevronUp
            size={14}
            strokeWidth={2}
            className={`text-foreground/35 transition-transform ${expanded ? "" : "rotate-180"}`}
          />
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-2 border-t border-foreground/[0.06]">
          {artifacts.map((a, i) => (
            <ArtifactItem
              key={i}
              artifact={a}
              index={i}
              sideEffect={matchSideEffect(a, sideEffects)}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
});

/* "Needs your input" question shape. Used to be a mock list derived from
 * card id; now built from the live backend `pendingInput` when kind is
 * a `send_message` pause. The Lovable visual layer (option chips +
 * Continue) reads from a 1-item array of this shape — see the main
 * component. */
interface InputOption { label: string }
interface InputQuestion { id: string; question: string; options: InputOption[] }


/* ── SSE event → ChatMessage projection ──
 *
 * The Lovable visual layer reads `messages: ChatMessage[]`. We derive that
 * shape from the SSE stream so the existing JSX (ActionPanel / ToolIconBadge
 * / ArtifactPanel / etc.) stays untouched.
 *
 *   chat:tool:start  → action message, status='running'
 *   chat:tool:result → flip the matched id to status='done'
 *   result           → summary message
 *   chat:error       → summary message tagged as failure
 *
 * `input_required` does NOT add a message — it surfaces as the
 * "Needs your input" panel below the action list, driven separately.
 */
function actionContentFromEvent(data: Record<string, unknown> | undefined): string {
  if (!data) return "Working";
  const name = String(data.name || "tool");
  const preview = String(data.argsPreview || "");
  if (!preview) return name;
  // Use the same "title · desc" splitter pattern Lovable's ActionRow expects.
  return `${name} · ${preview.length > 60 ? preview.slice(0, 58) + "…" : preview}`;
}

function formatTs(ts?: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "";
  }
}

function eventsToMessages(events: SSEEvent[], cardTitle: string): ChatMessage[] {
  const msgs: ChatMessage[] = [
    {
      id: "card-ref",
      sender: "ai",
      type: "card-ref",
      content: cardTitle,
      timestamp: "",
    },
  ];
  // Map toolCallId → msg index so chat:tool:result can flip the matching row.
  const toolCalls = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "chat:tool:start") {
      const data = ev.data ?? {};
      const toolCallId = String(data.toolCallId || `tc-${msgs.length}`);
      // Skip the send_message tool — it's the pause point itself,
      // not a step the user needs to see as a "running" action.
      const name = String(data.name || "");
      if (name === "send_message") continue;
      const content = actionContentFromEvent(data);
      msgs.push({
        id: `action-${toolCallId}`,
        sender: "ai",
        type: "action",
        content,
        status: "running",
        timestamp: formatTs(ev.ts),
      });
      toolCalls.set(toolCallId, msgs.length - 1);
    } else if (ev.type === "chat:tool:result") {
      const data = ev.data ?? {};
      const toolCallId = String(data.toolCallId || "");
      const idx = toolCalls.get(toolCallId);
      if (idx !== undefined) {
        msgs[idx] = { ...msgs[idx], status: "done" };
      }
    } else if (ev.type === "input_required") {
      // Agent paused at send_message. Any tool row still "running" by
      // this point is an unmatched chat:tool:start that never received
      // its chat:tool:result
      // — most often happens when LangGraph swallows on_tool_end after a
      // Pydantic args-validation failure (we still got chat:tool:start
      // because the tool was named in the model's tool_calls array, but
      // the validator rejected the args before invocation). The agent
      // has clearly moved past these, so visually mark them done so the
      // user doesn't see a hung spinner on a tool the agent retried.
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].status === "running") {
          msgs[i] = { ...msgs[i], status: "done" };
        }
      }
    } else if (ev.type === "result") {
      const summary = String(
        (ev.data as Record<string, unknown>)?.summary || "Done.",
      );
      // Make sure every preceding action is marked done — agent message
      // arrived after the last tool completed.
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].status === "running") {
          msgs[i] = { ...msgs[i], status: "done" };
        }
      }
      msgs.push({
        id: "summary",
        sender: "ai",
        type: "text",
        content: summary,
        timestamp: formatTs(ev.ts),
      });
    } else if (ev.type === "chat:error") {
      const err = String(
        (ev.data as Record<string, unknown>)?.error || "Run failed.",
      );
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].status === "running") {
          msgs[i] = { ...msgs[i], status: "done" };
        }
      }
      msgs.push({
        id: "summary",
        sender: "ai",
        type: "text",
        content: `Failed: ${err}`,
        timestamp: formatTs(ev.ts),
      });
    }
  }
  return msgs;
}

/* Map snapshot.status → Lovable's local taskState shape. */
type LocalTaskState =
  | "running"
  | "needs-input"
  | "pending-done"
  | "done"
  | "dismissed";

function statusToTaskState(
  status: string | undefined,
  pending: PendingInput | null,
): LocalTaskState {
  if (!status) return "running";
  if (status === "needs_input" && pending) return "needs-input";
  if (status === "pending_done") return "pending-done";
  if (status === "done") return "done";
  if (status === "error") return "done"; // surface as terminal so the toolbar shows the feedback row
  if (status === "cancelled") return "dismissed";
  return "running";
}

export default function ChatDetailView({
  card,
  runId,
  onBack,
  onRetry,
  bootstrap,
  onDismissBackend,
  onDoneBackend,
}: ChatDetailViewProps) {
  // Pass `null` when runId is absent so the hook idles. Production callers
  // always supply runId; the optional shape is just so the dead Lovable
  // demo layouts still type-check.
  // `bootstrap` (when set) gets fired as the first HumanMessage if the
  // card-thread has no persisted turns yet — see the hook's
  // empty-thread bootstrap path for the rationale.
  const run = useCardExecutionRun(runId ?? null, { bootstrap });

  // Browser-tool surface: the card-execution agent shares the same
  // browser_tool that main chat uses. Mirror MainChatView's hookup so
  // when the agent calls `open` / `request_takeover` the Live View
  // iframe + takeover banner render here, not just inside Main Chat.
  // SSE keys off the card-thread session_key the agent runs under;
  // useBrowserSession bails when the string is empty (idle Lovable
  // demo path passes runId=null).
  const browserSessionKey = runId ? `card-thread-${runId}` : "";
  const {
    session: browserSession,
    setControl: setBrowserControl,
    sendInput: sendBrowserInput,
    refreshLiveView,
    close: closeBrowserSession,
  } = useBrowserSession(browserSessionKey);
  const [browserStage, setBrowserStage] = useState<SheetStage | "closed">(
    "closed",
  );
  // Re-mount the Browserbase iframe when iOS resumes the app — same
  // rationale as MainChatView: the WebSocket may have been paused
  // while bg and the signed iframe URL may have expired.
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const lastReloadAtRef = useRef(0);
  useEffect(() => {
    const bump = () => {
      const now = Date.now();
      if (now - lastReloadAtRef.current < 1500) return;
      lastReloadAtRef.current = now;
      void (async () => {
        await refreshLiveView();
        setIframeReloadKey((k) => k + 1);
      })();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshLiveView]);
  const handleBrowserInputText = useCallback(
    (text: string) => sendBrowserInput({ type: "text", text }),
    [sendBrowserInput],
  );
  const handleBrowserInputKey = useCallback(
    (key: string) => sendBrowserInput({ type: "key", key }),
    [sendBrowserInput],
  );
  const handleBrowserInputClick = useCallback(
    (x: number, y: number) => sendBrowserInput({ type: "click", x, y }),
    [sendBrowserInput],
  );
  const handleBrowserInputScroll = useCallback(
    (dx: number, dy: number) => sendBrowserInput({ type: "scroll", dx, dy }),
    [sendBrowserInput],
  );
  const handleBrowserControlChange = useCallback(
    (mode: "ai" | "user") => {
      void setBrowserControl(mode);
    },
    [setBrowserControl],
  );
  const handleBrowserClose = useCallback(() => {
    void closeBrowserSession();
  }, [closeBrowserSession]);

  // Derive Lovable-shaped messages from the live SSE event stream.
  // Stable identity per event so memo'd ActionRow / ActionPanel don't flicker.
  const sseMessages = useMemo(
    () => eventsToMessages(run.events, card.title),
    [run.events, card.title],
  );

  // User bubbles for replies typed / chip-picked into the panel. Each carries the
  // number of SSE events that had been seen at the moment of submit, so
  // the renderer can interleave the bubble chronologically with later
  // streamed actions (matches Lovable's segmented "user bubble → Continued
  // panel" layout that splits on the `user-input-*` id prefix).
  interface BubbleEntry {
    bubble: ChatMessage;
    afterEventCount: number;
  }
  const [userBubbles, setUserBubbles] = useState<BubbleEntry[]>([]);

  // Combined messages array consumed by the JSX render block below.
  // Interleave bubbles at their captured event-count position so steer
  // reasons stay above the events the agent produced in response.
  const messages = useMemo<ChatMessage[]>(() => {
    if (userBubbles.length === 0) return sseMessages;
    const out: ChatMessage[] = [];
    let bubbleIdx = 0;
    const sorted = [...userBubbles].sort(
      (a, b) => a.afterEventCount - b.afterEventCount,
    );
    // Emit sseMessages, splicing bubbles in at their captured indices.
    // The base offset (1) accounts for the leading card-ref message that
    // eventsToMessages always prepends regardless of event count.
    for (let i = 0; i < sseMessages.length; i++) {
      out.push(sseMessages[i]);
      while (
        bubbleIdx < sorted.length &&
        sorted[bubbleIdx].afterEventCount <= i
      ) {
        out.push(sorted[bubbleIdx].bubble);
        bubbleIdx++;
      }
    }
    // Trailing bubbles (submitted before any new events arrived).
    while (bubbleIdx < sorted.length) {
      out.push(sorted[bubbleIdx].bubble);
      bubbleIdx++;
    }
    return out;
  }, [sseMessages, userBubbles]);

  const [inputValue, setInputValue] = useState("");
  const [cardDrawerOpen, setCardDrawerOpen] = useState(false);
  // Pause/Resume is a local UI freeze only — there's no server-side pause
  // (agent already pauses at interrupts), so this just hides the spinner.
  const [isPaused, setIsPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Task lifecycle — strictly derived from the run snapshot so we never
  // diverge from the backend's authoritative state machine.
  const taskState: LocalTaskState = useMemo(
    () => statusToTaskState(run.snapshot?.status, run.snapshot?.pendingInput ?? null),
    [run.snapshot?.status, run.snapshot?.pendingInput],
  );

  // The needs-input panel below is the ONLY user-reply surface in
  // this iteration. While the agent is paused on a `send_message`
  // interrupt, the panel renders the option chips + a permanent
  // free-text input slot + a Continue (=Reply) button. There is no
  // global bottom input bar and no separate Steer affordance — every
  // reply, whether by chip or by typing, flows through the panel.
  //
  // `isPaused` (above, the run-display Pause/Resume button) is a
  // separate manual UI toggle that just freezes the visual timeline;
  // `awaitingInput` here is the backend-driven "agent is paused
  // waiting for user" condition.
  const pendingKind = run.snapshot?.pendingInput?.kind;
  const awaitingInput = pendingKind === "message";
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The "Needs your input" panel below the action list — a SINGLE
  // unified surface for every pause. The agent's `send_message` tool
  // carries the chat text in `message` and optional quick-reply chip
  // labels in `options`. The FE never synthesises chips itself — if
  // the agent didn't supply any, the panel renders only the message +
  // free-text input slot.
  const inputQuestions = useMemo<InputQuestion[]>(() => {
    const p = run.snapshot?.pendingInput;
    if (!p || p.kind !== "message") return [];
    const agentOptions = (p.options ?? []).map((label) => ({ label }));
    return [
      {
        id: "message",
        question: p.message || "",
        options: agentOptions,
      },
    ];
  }, [run.snapshot?.pendingInput]);

  const activeQuestionIndex: number | null = inputQuestions.length > 0 ? 0 : null;
  const [selectedOption, setSelectedOption] = useState<number>(0);
  // Reset selection whenever a new question arrives. Keyed off the
  // first question's text since `inputQuestions` is always 0 or 1 long.
  const currentQuestionText = inputQuestions[0]?.question ?? null;
  useEffect(() => {
    setSelectedOption(0);
  }, [currentQuestionText]);

  // Sources for the optional drawer body.
  const sources = card.line2
    .replace("Sources:", "")
    .replace("Sources: ", "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);

  // Derive action progress for the header chip.
  const actionMessages = useMemo(
    () => messages.filter((m) => m.type === "action"),
    [messages],
  );
  const totalSteps = (() => {
    const p = run.snapshot?.pendingInput;
    // While paused with a known plan, prefer that count; otherwise
    // fall back to how many tool actions we've actually streamed.
    if (p?.kind === "message" && (p.plan?.length ?? 0) > 0) {
      return p.plan!.length;
    }
    return actionMessages.length;
  })();
  const completedSteps = actionMessages.filter((m) => m.status === "done").length;
  const summaryMsg = messages.find((m) => m.id === "summary");
  const askMsg = messages.find((m) => m.id === "ai-ask");
  const isDone = taskState === "done";
  const isRunning = taskState === "running";

  // The Continue button (+ Enter in the input box) is THE single
  // "reply" surface. Whatever the user sends — chip label OR typed
  // text — is a plain string delivered to the paused agent. The
  // agent interprets it (affirmative → execute the plan; anything
  // else → treat as an instruction). There is no separate Approve /
  // Steer / Send / SubmitInput in the UI; there isn't one in the
  // backend either (single `/reply` endpoint).
  //
  // Routing:
  //   - typed text non-empty → that's the reply (wins over any chip)
  //   - typed text empty     → reply is the selected chip's label
  const [busy, setBusy] = useState(false);
  const handleApprove = async () => {
    if (busy) return;
    const pending = run.snapshot?.pendingInput;
    if (!pending) return;

    const typed = inputValue.trim();
    const replyText = typed
      || inputQuestions[0]?.options[selectedOption]?.label
      || "";
    // Don't fire on an empty intent (no chip selected, no text typed).
    if (!replyText) return;

    setBusy(true);
    // Optimistic user bubble so the user sees their reply land
    // immediately, regardless of backend round-trip latency.
    setUserBubbles((prev) => [
      ...prev,
      {
        bubble: {
          id: `user-input-${prev.length + 1}`,
          sender: "user",
          type: "text",
          content: replyText,
          timestamp: "",
        },
        afterEventCount: run.events.length,
      },
    ]);
    setInputValue("");

    try {
      await run.reply(replyText);
    } catch (e) {
      console.warn("reply failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await run.cancel();
      // Persist the user's intent: POST /feedback kind=dismiss so the
      // card drops out of the sphere and shows as Dismissed in TASKS.
      // Mirrors the home Drawer's Dismiss path. The hook's `cancel`
      // alone is local UI state only.
      if (onDismissBackend) onDismissBackend();
    } catch (e) {
      console.warn("cancel failed:", e);
    } finally {
      setBusy(false);
      setTimeout(onBack, 200);
    }
  };

  const handlePauseToggle = () => setIsPaused((p) => !p);

  // pending_done → done. User confirmed the run is finished.
  const handleConfirmDone = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await run.confirmDone();
      // Persist the user's intent: POST /feedback kind=card_action
      // action=complete so the card moves from the sphere into TASKS as
      // Completed. The hook's `confirmDone` alone is local UI state.
      if (onDoneBackend) onDoneBackend();
    } catch (e) {
      console.warn("confirmDone failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const newId = await run.retry();
      if (onRetry) onRetry(newId);
    } catch (e) {
      console.warn("retry failed:", e);
    } finally {
      setBusy(false);
    }
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

      {/* Chat region wrapper — `relative flex-1 min-h-0` so the top-sheet
          BrowserPanel can be `absolute top-0` to this region (mirrors
          MainChatView's structure). Without this wrapper the panel would
          either anchor to the root and cover the header, or have no
          ResizeObserver target for its fit-to-height math. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <BrowserPanel
          session={
            browserSession
              ? {
                  browserSessionId: browserSession.sessionKey,
                  liveViewUrl: browserSession.liveViewUrl,
                  viewport: browserSession.viewport,
                  deviceKind: browserSession.deviceKind,
                  currentUrl: browserSession.currentUrl,
                  controlMode: browserSession.controlMode,
                  takeoverReason: browserSession.takeoverReason,
                }
              : null
          }
          iframeReloadKey={iframeReloadKey}
          onControlChange={handleBrowserControlChange}
          onUserInputText={handleBrowserInputText}
          onUserInputKey={handleBrowserInputKey}
          onUserInputClick={handleBrowserInputClick}
          onUserInputScroll={handleBrowserInputScroll}
          onClose={handleBrowserClose}
          onStageChange={setBrowserStage}
          composerFocused={false}
        />

      {/* Task body */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        style={{
          // Leave room for the BrowserPanel's mini drag bar when it's
          // peeked. medium / full deliberately cover the chat — that's
          // the whole point of expanding — so no offset there.
          paddingTop: browserStage === "mini" ? 32 : undefined,
        }}
      >
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

        {/* ── Unified timeline rendering ──
         *
         * Layout (top → bottom):
         *
         *   1. ONE consolidated tool group (all action messages across
         *      the run's lifetime, collapsible). Stays pinned near the
         *      top — we no longer interleave tool sub-groups between
         *      user replies, so the user sees one "what the agent did"
         *      surface instead of N scattered chunks.
         *
         *   2. The latest drafts card (when present) — sits just below
         *      the tool group so the user always has the freshest
         *      content one scroll away.
         *
         *   3. Chat history — every past `input_required` event renders
         *      as a static pause card (question + read-only chip
         *      labels) followed by the user's reply bubble. The LAST
         *      pause, if the agent is still waiting on it, renders as
         *      the live interactive panel (chips clickable, free-text
         *      input visible, Continue button). All prior pauses are
         *      preserved so the user can scroll up and see the full
         *      back-and-forth, exactly like a chat transcript.
         *
         *   4. Result card (when pending_done / done / error).
         *
         *   5. Persistent reply box (pending_done only) — lets the user
         *      keep talking (`continueWith` spawns a new run) until they
         *      explicitly click Done in the top toolbar.
         */}

        {/* 1. Consolidated tool group. */}
        {(() => {
          const allActions = messages.filter((m) => m.type === "action");
          if (allActions.length === 0) return null;
          return (
            <CollapsibleActionGroup
              items={allActions}
              label="Execution"
              isPaused={isPaused}
              defaultCollapsed={awaitingInput || isDone || taskState === "pending-done"}
            />
          );
        })()}

        {/* 2. Drafts card — latest version, collapsible, auto-re-expands on
         *    each new `send_message` payload (driven by `messageCount`). */}
        {(() => {
          const liveDrafts = run.lastMessagePayload?.drafts ?? [];
          const artifacts = liveDrafts.map(executeArtifactToLovable);
          if (artifacts.length === 0) return null;
          // When the run is pending_done / done, the drafts may have a
          // matching side_effect (e.g. "Email · Sent"); pass them so the
          // ArtifactItem badge upgrades.
          const sideEffects = run.snapshot?.result?.side_effects ?? [];
          return (
            <ArtifactPanel
              artifacts={artifacts}
              sideEffects={sideEffects}
              version={run.messageCount}
            />
          );
        })()}

        {/* 3. Chat history — pause cards + user reply bubbles in
         *    chronological order. The latest pause is interactive when
         *    the run is currently `needs_input`. */}
        {(() => {
          // Index every input_required event so we can pair each with
          // the user reply that came after it (and before the next
          // pause).
          const pauseEvents = run.events
            .map((ev, idx) => ({ ev, idx }))
            .filter(({ ev }) => ev.type === "input_required");
          if (pauseEvents.length === 0) return null;

          // Past user replies are persisted in metadata_json.plan_revisions
          // (the backend appends one entry per `/reply` POST). The Nth
          // entry pairs with the Nth pause event. This is the durable
          // source so historical replies survive page refresh / SSE
          // reconnect; `userBubbles` is only the optimistic local
          // state for the most-recently-sent reply (visible immediately
          // before the server round-trip completes).
          const mdRaw = run.snapshot?.metadata as Record<string, unknown> | undefined;
          const planRevisions: Array<{ reply?: string }> = Array.isArray(mdRaw?.plan_revisions)
            ? (mdRaw.plan_revisions as Array<{ reply?: string }>)
            : [];

          // The agent is still paused on the LAST input_required iff
          // BOTH conditions hold:
          //   (a) backend status is `needs_input` (waiting for reply)
          //   (b) snapshot.pendingInput is non-null (payload present)
          //
          // Checking only (b) used to glitch during the brief resuming
          // window: `run.reply()` patches local status → "resuming"
          // but leaves the stale `pendingInput` on the snapshot
          // (backend cleared it remotely; our reducer's `patch_status`
          // touches status only). That caused the latest pause card
          // to be classified as "active" → skipped in the static loop
          // AND not rendered by the interactive AnimatePresence below
          // (which gates on `taskState === "needs-input"`), so the
          // card vanished until the next pause arrived. Anchoring on
          // status fixes that — the moment the user replies, status
          // flips to "resuming" and the pause renders as static.
          const lastPauseIsActive =
            run.snapshot?.status === "needs_input"
            && !!run.snapshot?.pendingInput;

          return (
            <>
              {pauseEvents.map(({ ev, idx }, i) => {
                const nextEventIdx = pauseEvents[i + 1]?.idx ?? run.events.length;
                // Prefer the persisted reply from plan_revisions (durable
                // across refresh / SSE reconnect). Fall back to the local
                // optimistic bubble if the persisted entry hasn't shown
                // up yet (the moment after Continue + before the next
                // snapshot fetch syncs).
                const persistedReply = planRevisions[i]?.reply?.trim() || null;
                const optimisticReply = userBubbles.find(
                  (b) => b.afterEventCount > idx && b.afterEventCount <= nextEventIdx,
                )?.bubble.content ?? null;
                const userReply = persistedReply ?? optimisticReply;
                const isActiveInteractive =
                  i === pauseEvents.length - 1 && lastPauseIsActive;
                // Active pause renders separately below (interactive
                // panel). Past pauses render as one merged exchange
                // card carrying both the agent's outgoing message and
                // the user's actual reply.
                if (isActiveInteractive) return null;
                return (
                  <StaticPauseCard
                    key={`pause-${idx}`}
                    index={i + 1}
                    total={pauseEvents.length}
                    data={ev.data as PendingInput | undefined}
                    userReply={userReply}
                  />
                );
              })}
            </>
          );
        })()}

        {/* 4. Result panel — pending_done / done / error.
         *    Sits BELOW the pause history so the user reads the
         *    conversation top-to-bottom and the result lands as the
         *    natural end-of-thread message. */}
        {(taskState === "pending-done" || isDone) && (() => {
          const status = run.snapshot?.status;
          const result = run.snapshot?.result;
          const summary = result?.summary?.trim() ?? "";
          const errorMsg = status === "error" ? (run.snapshot?.errorMessage ?? "") : "";

          // Error path — red banner with the underlying message.
          if (errorMsg) {
            return (
              <motion.div
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl px-4 py-3 border border-red-500/30 bg-red-500/[0.04]"
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Zap size={12} className="text-red-600" strokeWidth={2.2} />
                  <p className="text-[11px] font-bold uppercase tracking-wider text-red-700">Failed</p>
                </div>
                <p className="text-[12.5px] text-foreground/75 leading-snug whitespace-pre-line">
                  {errorMsg.slice(0, 240)}{errorMsg.length > 240 ? "…" : ""}
                </p>
              </motion.div>
            );
          }

          // No summary — nothing to show (rare: cancelled status that
          // somehow reached this branch).
          if (!summary) return null;

          return (
            <motion.div
              layout
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
              className="rounded-2xl border border-pink-200/40 overflow-hidden"
              style={{ background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.03) 100%)" }}
            >
              <div className="px-4 pt-3 pb-3">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Zap size={12} className="text-[hsl(292,78%,63%)]" strokeWidth={2.2} />
                  <p className="text-[11px] font-bold uppercase tracking-wider bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                    Result
                  </p>
                </div>
                <p className="text-[13px] text-foreground/80 leading-relaxed whitespace-pre-line">
                  {summary}
                </p>
              </div>
            </motion.div>
          );
        })()}

        {/* 5. Persistent reply box for pending_done — lets the user keep
         *    talking after the agent thinks it's done. Typing here +
         *    Continue triggers `continueWith` (cancels the old run +
         *    spawns a new one carrying the typed text as continuation
         *    context). The task isn't truly over until the user clicks
         *    Done in the top toolbar. */}
        {taskState === "pending-done" && (
          <ContinueReplyBox
            busy={busy}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={async () => {
              const text = inputValue.trim();
              if (!text || busy) return;
              setBusy(true);
              setUserBubbles((prev) => [
                ...prev,
                {
                  bubble: {
                    id: `user-input-${prev.length + 1}`,
                    sender: "user",
                    type: "text",
                    content: text,
                    timestamp: "",
                  },
                  afterEventCount: run.events.length,
                },
              ]);
              setInputValue("");
              try {
                const newId = await run.continueWith(text);
                if (onRetry) onRetry(newId);
              } catch (e) {
                console.warn("continue failed:", e);
              } finally {
                setBusy(false);
              }
            }}
          />
        )}

        {/* Live interactive needs-input panel — renders only when the
         *    agent is currently paused on the latest input_required.
         *    Positioned here so it always appears at the bottom of the
         *    pause history list (last item in the chat thread). */}
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

                {/* Current question. `whitespace-pre-line` preserves
                    whatever newlines the agent put in (safety net for
                    when agent slips and includes multi-line content
                    here despite the prompt's hard rule — structured
                    content should go through `send_message`'s `drafts`
                    field, not the `message` text).
                    Weight is `medium` instead of `semibold` so longer
                    questions stay readable. */}
                <p className="text-[13.5px] text-foreground/85 font-medium leading-snug mb-2.5 whitespace-pre-line">
                  {currentQ.question}
                </p>

                {/* Options as selectable chips */}
                {currentQ.options.length > 0 && (
                  <div className="space-y-1.5">
                    {currentQ.options.map((opt, i) => {
                      const isSelected = i === selectedOption;
                      return (
                        <button
                          key={i}
                          onClick={() => {
                            setSelectedOption(i);
                            // Typed text always wins over a chip pick —
                            // clear it so the user's intent is unambiguous.
                            if (inputValue) setInputValue("");
                          }}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left text-[13px] border"
                          style={{
                            background: isSelected && !inputValue.trim()
                              ? "hsl(0 0% 0% / 0.04)"
                              : "rgba(255,255,255,0.5)",
                            borderColor: isSelected && !inputValue.trim()
                              ? "hsl(0 0% 0% / 0.55)"
                              : "hsl(0 0% 0% / 0.08)",
                            transition: "background 240ms ease, border-color 240ms ease",
                          }}
                        >
                          <span className={`flex-1 transition-colors duration-200 ${isSelected && !inputValue.trim() ? "text-foreground font-medium" : "text-foreground/70"}`}>
                            {opt.label}
                          </span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <span
                              className="w-4 h-4 rounded-full border flex items-center justify-center"
                              style={{
                                borderColor: isSelected && !inputValue.trim() ? "hsl(0 0% 0%)" : "hsl(0 0% 0% / 0.18)",
                                background: isSelected && !inputValue.trim() ? "hsl(0 0% 0%)" : "transparent",
                                transition: "background 240ms ease, border-color 240ms ease",
                              }}
                            >
                              {isSelected && !inputValue.trim() && (
                                <Check size={10} strokeWidth={3} className="text-white" />
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Fixed free-text input row, ALWAYS visible — the
                    "type your own answer" slot. Typed text overrides
                    chip selection at submit time. */}
                <div
                  className="mt-2.5 px-3 py-2 rounded-xl border border-foreground/10 flex items-center gap-2"
                  style={{ background: "rgba(255,255,255,0.55)" }}
                >
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleApprove();
                      }
                    }}
                    placeholder={
                      currentQ.options.length > 0
                        ? "Or type your own reply..."
                        : "Type your reply..."
                    }
                    className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 outline-none"
                  />
                  <VoiceButton onUpdate={setInputValue} />
                </div>

                <button
                  type="button"
                  onClick={() => void handleApprove()}
                  // When the agent provided no chips, there's nothing to
                  // submit until the user types something. With chips
                  // available, the default-selected chip (index 0)
                  // covers the empty-text case.
                  disabled={
                    busy ||
                    (currentQ.options.length === 0 && !inputValue.trim())
                  }
                  className="mt-3 w-full px-4 py-2.5 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  {busy ? (
                    <><Loader2 size={13} className="animate-spin" /> Sending…</>
                  ) : (
                    <>Continue <ArrowRight size={13} strokeWidth={2.5} /></>
                  )}
                </button>
              </motion.div>
            );
          })()}
        </AnimatePresence>

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

      {/* Action toolbar — varies by task state */}
      {taskState !== "dismissed" && (actionMessages.length > 0 || summaryMsg || askMsg) && (
        <div className="px-4 pt-2">
          {taskState === "done" ? (
            // Done: feedback + optional Retry (shown only when the run
            // ended in error so the user can re-attempt without going
            // back to the home Drawer).
            <div
              className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl border border-foreground/8"
              style={{ background: "rgba(255,255,255,0.5)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
            >
              <span className="text-[12px] text-foreground/55 font-medium">
                {run.snapshot?.status === "error" ? "Run failed." : "Was this helpful?"}
              </span>
              <div className="flex items-center gap-1.5">
                {run.snapshot?.status === "error" && onRetry && (
                  <button
                    onClick={handleRetry}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3 h-8 rounded-full bg-foreground text-background hover:bg-foreground/85 transition-colors text-[12px] font-semibold disabled:opacity-50"
                  >
                    <Check size={12} strokeWidth={2.5} /> Retry
                  </button>
                )}
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
              </div>
            </div>
          ) : taskState === "pending-done" ? (
            // Agent finished, user hasn't confirmed yet.
            // Toolbar: Dismiss | Done. No standalone Steer/Continue —
            // "reply with more instructions" is intentionally not
            // exposed in this iteration; user must Dismiss + start
            // fresh if they want to redirect post-completion.
            <div className="flex items-center gap-2">
              <button
                onClick={handleDismiss}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55 disabled:opacity-50"
              >
                <X size={13} strokeWidth={2} /> Dismiss
              </button>
              <button
                onClick={handleConfirmDone}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-50"
              >
                <Check size={13} strokeWidth={2.5} /> Done
              </button>
            </div>
          ) : awaitingInput ? (
            // Awaiting user reply — the needs-input panel above carries
            // chips + free-text input + Continue (=Reply) button. The
            // top toolbar reduces to just Dismiss to keep the reply
            // surface single-sourced.
            <div className="flex items-center gap-2">
              <button
                onClick={handleDismiss}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55 disabled:opacity-50"
              >
                <X size={13} strokeWidth={2} /> Dismiss
              </button>
            </div>
          ) : (
            // Running (agent working, not paused for input): toolbar is
            // just Dismiss + Pause/Resume. No Steer — the user reaches
            // the agent ONLY through the needs-input panel's Reply
            // affordance when the agent pauses, by design (no chat-
            // injection mid-flight in this iteration).
            <div className="flex items-center gap-2">
              <button
                onClick={handleDismiss}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55 disabled:opacity-50"
              >
                <X size={13} strokeWidth={2} /> Dismiss
              </button>
              <button
                onClick={handlePauseToggle}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold text-background transition-colors"
                style={{ background: isPaused ? "hsl(var(--foreground))" : "linear-gradient(135deg, hsl(292 78% 63%), hsl(330 80% 65%))" }}
              >
                {isPaused ? (<><Play size={13} strokeWidth={2.2} fill="currentColor" /> Resume</>) : (<><Pause size={13} strokeWidth={2.2} /> Pause</>)}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bottom global input bar — only when NOT awaiting a panel-level
          answer. The needs-input panel above has its own permanent
          input slot; surfacing this bar at the same time would create
          two competing send paths. */}
      {/* Bottom spacer where the global input bar used to live. The
          reply surface is now exclusively inside the needs-input panel
          (chips + free-text + Continue). When the agent isn't paused
          there is no UI for typing — by design in this iteration. */}
      <div className="pb-5" />
      </div>
      {/* /chat region wrapper */}


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
          <ChatCardDrawerBody
            card={card}
            sources={sources}
            runSnapshot={run.snapshot}
            lastMessagePayload={run.lastMessagePayload}
            sideEffects={run.snapshot?.result?.side_effects ?? []}
          />
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

/* Drawer body — mirrors home CardDrawerContent (no action buttons). The
 * optional `runSnapshot` + `lastMessagePayload` + `sideEffects` let
 * DrawerDetailBody render the LIVE plan + drafts + dangerous_actions +
 * post-execution side-effect badges pulled from the agent's pending_input
 * (and the cached send_message snapshot) rather than the card's static
 * mock. This is the same data the home drawer uses; the chat-side
 * drawer must mirror it so opening the drawer from inside a card never
 * shows a stale view. */
function ChatCardDrawerBody({
  card,
  runSnapshot,
  lastMessagePayload,
  sideEffects = [],
}: {
  card: ChatCard;
  sources: string[];
  runSnapshot?: RunSnapshot | null;
  lastMessagePayload?: LastMessagePayload | null;
  sideEffects?: SideEffect[];
}) {
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

      {card.detail && (
        <DrawerDetailBody
          card={card}
          runSnapshot={runSnapshot}
          lastMessagePayload={lastMessagePayload}
          sideEffects={sideEffects}
        />
      )}
    </div>
  );
}

