/**
 * ProposeActionCard — renders the card-execution agent's structured
 * pause UI inside the conversation thread.
 *
 * Wire shape: the agent calls the `propose_action` tool with a typed
 * payload (message + drafts + options + plan + dangerous_actions +
 * risks). The conversation runtime surfaces the raw tool args to this
 * component (ConversationView's assistant turn). We render:
 *
 *   - The agent's chat message at the top
 *   - A collapsible "Generated draft" card per artifact in `drafts`
 *   - A pink "NEEDS YOUR INPUT" panel: option chips (read from
 *     `options`) + permanent free-text input + Continue button.
 *
 * User reply path: tapping a chip or typing into the input + Continue
 * calls `onReply` (the runtime's sendMessage) — the agent receives the
 * reply as a HumanMessage on its next turn.
 *
 * Plan / dangerous_actions / risks fields are intentionally NOT
 * rendered in this chat-thread card — they're audit metadata for the
 * home drawer's pre-review view, which reads them out of the same
 * tool-call args. Keeping the conversation scrollback focused on
 * (message + drafts + reply) keeps the surface readable.
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  Check,
  ChevronUp,
  Loader2,
  FileText,
  Mail,
  MessageSquare,
} from "lucide-react";
import { VoiceButton } from "@/components/voice";
import { cn } from "@/lib/utils";

interface ProposeActionArtifact {
  kind: "email_draft" | "message" | "doc" | "other";
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}

interface ProposeActionArgs {
  message: string;
  drafts?: ProposeActionArtifact[] | null;
  options?: string[] | null;
  // plan / dangerous_actions / risks are present on the wire but
  // rendered in the drawer, not here. We type them as unknown so
  // TS doesn't complain if the agent omits or pads the field.
  plan?: unknown;
  dangerous_actions?: unknown;
  risks?: unknown;
}

/** Tolerantly project the conversation runtime's tool-args blob into the shape
 *  we expect.
 *
 *  Wire layout: the runtime's snapshot args dict carries string
 *  metadata fields (status / meta / argsPreview) at the top level
 *  plus an optional `input` field with the raw structured tool args
 *  (see chat/tool-steps.ts). We read `input` for the propose_action
 *  payload; if it's missing (very old chat:tool:start events without
 *  the `args` field, or a tool call that exceeded the 8 KB cap), we
 *  fall back to reading the top-level keys directly so an LLM that
 *  somehow puts message/drafts/options at the root still renders.
 */
function parseArgs(raw: unknown): ProposeActionArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const inner = r.input && typeof r.input === "object"
    ? (r.input as Record<string, unknown>)
    : r;
  const message = typeof inner.message === "string" ? inner.message : "";
  if (!message) return null;
  const drafts = Array.isArray(inner.drafts)
    ? (inner.drafts.filter((d) => d && typeof d === "object") as ProposeActionArtifact[])
    : null;
  const options = Array.isArray(inner.options)
    ? (inner.options.filter((o) => typeof o === "string") as string[])
    : null;
  return { message, drafts, options };
}

const ARTIFACT_ICON: Record<ProposeActionArtifact["kind"], typeof FileText> = {
  email_draft: Mail,
  message: MessageSquare,
  doc: FileText,
  other: FileText,
};

const ARTIFACT_LABEL: Record<ProposeActionArtifact["kind"], string> = {
  email_draft: "Email draft",
  message: "Message draft",
  doc: "Document",
  other: "Draft",
};

function DraftItem({ artifact, index }: { artifact: ProposeActionArtifact; index: number }) {
  // First artifact expanded by default so the user sees content
  // without an extra tap; subsequent ones collapsed to keep the
  // surface scannable.
  const [expanded, setExpanded] = useState(index === 0);
  const Icon = ARTIFACT_ICON[artifact.kind] ?? FileText;
  const label = ARTIFACT_LABEL[artifact.kind] ?? "Draft";
  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.28, ease: [0.32, 0.72, 0, 1] } }}
      className="rounded-xl border border-foreground/8 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.65)" }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-white border border-foreground/10 flex items-center justify-center shrink-0">
          <Icon size={14} strokeWidth={1.8} className="text-foreground/65" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground/40 leading-none mb-1">
            {label}
          </p>
          <p className="text-[13px] font-semibold text-foreground/85 truncate leading-tight">
            {artifact.title}
          </p>
        </div>
        <ChevronUp
          size={14}
          strokeWidth={2}
          className={cn(
            "text-foreground/35 shrink-0 transition-transform duration-300",
            !expanded && "rotate-180",
          )}
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
            <div className="px-3.5 pb-3 pt-2 border-t border-foreground/[0.06]">
              <p className="text-[12.5px] text-foreground/75 leading-relaxed whitespace-pre-line">
                {artifact.body}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function ProposeActionCard({
  args,
  onReply,
  busy,
}: {
  args: unknown;
  /** Enqueue the user's reply — the conversation runtime's sendMessage. */
  onReply: (text: string) => void | Promise<void>;
  /** True while a turn is streaming on this thread — disables Continue. */
  busy: boolean;
}) {
  const parsed = parseArgs(args);

  const [inputValue, setInputValue] = useState("");
  const [selectedOption, setSelectedOption] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Once the user replies to THIS pause, lock the panel: re-replying to an
  // already-answered propose_action makes no sense and would double-send in
  // the window between the POST returning and the next turn streaming.
  const [sent, setSent] = useState(false);

  // Reset when the agent's question changes — keyed off the message text so
  // each fresh propose_action gets a clean, un-sent default.
  useEffect(() => {
    setSelectedOption(0);
    setInputValue("");
    setSent(false);
  }, [parsed?.message]);

  if (!parsed) return null;

  const options = parsed.options ?? [];
  const drafts = parsed.drafts ?? [];
  const isRunning = busy || submitting;
  const locked = isRunning || sent;

  const submitReply = async () => {
    const typed = inputValue.trim();
    const replyText = typed || options[selectedOption] || "";
    if (!replyText || locked) return;
    setInputValue("");
    setSubmitting(true);
    try {
      await onReply(replyText);
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  // The chip+input panel always renders interactive. While the thread
  // is running, the Continue button is disabled and chips are visually
  // muted; the user's next reply will be tied to the latest agent
  // turn regardless of which propose_action they clicked from (assistant-
  // ui appends to the end of the thread). For historical clarity this
  // is acceptable in v1; a future iteration can show prior pauses as
  // static once a user reply lands after them.
  return (
    <div className="my-3 flex flex-col gap-3">
      {/* Drafts (when present) */}
      {drafts.length > 0 && (
        <div className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <DraftItem key={i} artifact={d} index={i} />
          ))}
        </div>
      )}

      {/* Needs your input panel */}
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
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
        </div>

        <p className="text-[13.5px] text-foreground/85 font-medium leading-snug mb-2.5 whitespace-pre-line">
          {parsed.message}
        </p>

        {options.length > 0 && (
          <div className="space-y-1.5">
            {options.map((opt, i) => {
              const isSelected = i === selectedOption && !inputValue.trim();
              return (
                <button
                  key={i}
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setSelectedOption(i);
                    if (inputValue) setInputValue("");
                  }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left text-[13px] border disabled:cursor-not-allowed"
                  style={{
                    background: isSelected
                      ? "hsl(0 0% 0% / 0.04)"
                      : "rgba(255,255,255,0.5)",
                    borderColor: isSelected
                      ? "hsl(0 0% 0% / 0.55)"
                      : "hsl(0 0% 0% / 0.08)",
                    transition: "background 240ms ease, border-color 240ms ease",
                  }}
                >
                  <span
                    className={cn(
                      "flex-1 transition-colors duration-200",
                      isSelected ? "text-foreground font-medium" : "text-foreground/70",
                    )}
                  >
                    {opt}
                  </span>
                  <span className="flex items-center shrink-0">
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
        )}

        {/* Permanent free-text input slot */}
        <div
          className="mt-2.5 px-3 py-2 rounded-xl border border-foreground/10 flex items-center gap-2"
          style={{ background: "rgba(255,255,255,0.55)" }}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitReply();
              }
            }}
            placeholder={
              sent
                ? "Reply sent"
                : options.length > 0
                  ? "Or type your own reply..."
                  : "Type your reply..."
            }
            disabled={locked}
            className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 outline-none disabled:opacity-50"
          />
          <VoiceButton prefill={inputValue} onUpdate={setInputValue} />
        </div>

        <button
          type="button"
          onClick={() => void submitReply()}
          disabled={
            locked
            || (options.length === 0 && !inputValue.trim())
          }
          className="mt-3 w-full px-4 py-2.5 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
        >
          {sent ? (
            <>
              <Check size={13} strokeWidth={2.5} /> Sent
            </>
          ) : isRunning ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Sending…
            </>
          ) : (
            <>
              Continue <ArrowRight size={13} strokeWidth={2.5} />
            </>
          )}
        </button>
      </motion.div>
    </div>
  );
}
