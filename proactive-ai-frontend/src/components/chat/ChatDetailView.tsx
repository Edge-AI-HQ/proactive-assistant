import { useState, useMemo, type JSX } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronUp, Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles, Globe, FileSearch, Settings, Hand, Database, Bell, DollarSign, Users, Search, Brain, Lock, X, type LucideIcon } from "lucide-react";
import { DrawerDetailBody } from "@/components/card/CardDrawerBody";
import ConversationView from "@/components/chat/conversation/ConversationView";
import type {
  LastMessagePayload,
  RunSnapshot,
  SideEffect,
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
  /** Explicit card type ("reminder" = acknowledge-only nudge). Rides into
   *  card_context so the agent switches behavior — see lib/reminder-card.ts. */
  cardKind?: string;
  /** Owning pai_scheduled_tasks id (reminder cards) — lets the agent edit
   *  this reminder's schedule via the scheduled_generator_* tools. */
  scheduleTaskId?: string;
  title: string;
  line1: string;
  line2: string;
  /** Generator-side rationale; rendered as a dedicated "WHY NOW" block
   *  in the chat-side drawer mirror (ChatCardDrawerBody). */
  whyNow?: string;
  sourceApps?: string[];
  reasoningSteps?: { label: string; detail: string }[];
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
   * always passes a real run id from AppLayout.
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
  onDismissBackend?: () => void | Promise<void>;
  /**
   * Backend feedback hook for the top-toolbar Done button. Same shape
   * as `onDismissBackend` — POSTs /feedback kind=card_action
   * action=complete so the card moves from sphere → TASKS as Completed.
   */
  onDoneBackend?: () => boolean | void | Promise<boolean | void>;
  /**
   * Fired on every chat:done (agent turn ended). Parent wires this to the
   * card layer so the sphere/timeline status flips the moment the agent
   * finishes instead of waiting for the next /cards poll.
   */
  onTurnDone?: () => void;
  /**
   * Result-bar Comment hook: persists the user's free-text feedback on this
   * card (POST /feedback kind=text_feedback — learning signal for the next
   * generation run, never messages the agent). Parent wires this to
   * `cardActions.textFeedback(realIntentCard, text)`.
   */
  onCommentBackend?: (text: string) => void | Promise<void>;
}

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

function cardThreadSessionKey(card: ChatCard, runId?: string): string {
  const raw = (runId ?? String(card.id)).trim();
  return raw.startsWith("card-thread-") ? raw : `card-thread-${raw}`;
}

function parseSources(line2: string): string[] {
  return line2
    .replace("Sources:", "")
    .replace("Sources: ", "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCardContext(card: ChatCard): Record<string, unknown> {
  return {
    title: card.title,
    category: card.category,
    tag: card.tag,
    // Card type + owning schedule task: the agent's <reminder_cards> prompt
    // branch keys on these (don't "execute" a nudge; edit the right task).
    ...(card.cardKind ? { cardKind: card.cardKind } : {}),
    ...(card.scheduleTaskId ? { scheduleTaskId: card.scheduleTaskId } : {}),
    summary: card.line1,
    whyNow: card.whyNow ?? card.line1,
    sources: parseSources(card.line2),
    primaryAction: card.detail?.willExecute
      ? { label: card.detail.willExecute, type: "confirm" }
      : undefined,
    detail: card.detail,
  };
}

function CardContextHeaderSlot({
  card,
  onOpen,
}: {
  card: ChatCard;
  onOpen: () => void;
}) {
  const plan = card.detail?.executionPlan ?? [];
  return (
    <div className="px-4 pt-3 pb-1">
      <button
        type="button"
        aria-label="View card details"
        onClick={onOpen}
        className="w-full rounded-2xl px-4 py-3 border border-foreground/8 text-left group"
        style={{
          background: "rgba(255,255,255,0.5)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
        }}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40 mb-1">
              Context
            </p>
            <p className="text-[13px] text-foreground/80 leading-relaxed line-clamp-2">
              {/* Reminder cards have no action — willExecute is just the
                  button label ("Done"); show the nudge itself. */}
              {card.cardKind === "reminder"
                ? card.line1
                : card.detail?.willExecute || card.line1}
            </p>
            {plan.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {plan.slice(0, 3).map((step, i) => {
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
                      <span className="text-[11.5px] text-foreground/60 truncate leading-snug">
                        {step.text}
                      </span>
                    </div>
                  );
                })}
                {plan.length > 3 && (
                  <span className="text-[10.5px] text-foreground/40 pl-[22px]">
                    +{plan.length - 3} more
                  </span>
                )}
              </div>
            )}
          </div>
          <ChevronUp
            size={13}
            className="text-foreground/30 group-hover:text-foreground/60 transition-colors shrink-0 mt-0.5"
          />
        </div>
      </button>
    </div>
  );
}

export default function ChatDetailView({
  card,
  runId,
  onBack,
  bootstrap,
  onTurnDone,
  onDismissBackend,
  onDoneBackend,
  onCommentBackend,
}: ChatDetailViewProps) {
  const [cardDrawerOpen, setCardDrawerOpen] = useState(false);
  const sessionKey = useMemo(
    () => cardThreadSessionKey(card, runId),
    [card, runId],
  );
  const cardContext = useMemo(() => buildCardContext(card), [card]);
  const sources = useMemo(() => parseSources(card.line2), [card.line2]);

  return (
    <>
      <ConversationView
        session={sessionKey}
        cardContext={cardContext}
        bootstrap={bootstrap}
        title={card.title}
        onBack={onBack}
        backIcon="left"
        onTurnDone={onTurnDone}
        cardFeedback={
          onDoneBackend && onCommentBackend
            ? { onDone: onDoneBackend, onComment: onCommentBackend }
            : undefined
        }
        placeholder="Message about this card..."
        headerSlot={
          <CardContextHeaderSlot
            card={card}
            onOpen={() => setCardDrawerOpen(true)}
          />
        }
      />

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
          />
          {/* Dismiss / Done are reachable from EVERY drawer (unified action
              model): both retire the card (negative / positive feedback),
              then close drawer + chat. */}
          {(onDismissBackend || onDoneBackend) && (
            <div className="flex items-center gap-2 px-5 pb-6 pt-1">
              {onDismissBackend && (
                <button
                  type="button"
                  onClick={() => {
                    setCardDrawerOpen(false);
                    void Promise.resolve(onDismissBackend()).finally(() => onBack());
                  }}
                  className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
                >
                  <X size={13} strokeWidth={2} /> Dismiss
                </button>
              )}
              {onDoneBackend && (
                <button
                  type="button"
                  onClick={() => {
                    setCardDrawerOpen(false);
                    void Promise.resolve(onDoneBackend()).finally(() => onBack());
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors"
                >
                  <Check size={13} strokeWidth={2.5} /> Done
                </button>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </>
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
