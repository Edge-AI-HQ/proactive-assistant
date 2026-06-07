/**
 * Grouped tool-activity card for assistant messages.
 *
 * Renders a contiguous run of tool-call parts as a single collapsible
 * card with a header ("Working · N tools" while any is running, else
 * "USED N TOOLS") and a chip list. Each chip shows the tool's icon,
 * human verb, and status badge; tap to expand and see the raw input /
 * output payload.
 *
 * `propose_action` is handled separately by ProposeActionCard (HITL
 * pause panel) and never reaches this component — AssistantMessage in
 * ConversationView flushes the group buffer before rendering it.
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import MarkdownContent from "./MarkdownContent";
import { resolveToolPresentation } from "./tool-presentation";

export interface ChatToolGroupItem {
  toolCallId: string;
  toolName: string;
  /** Subset of ToolCallSnapshotArgs we actually read in the UI. */
  args: {
    status?: string;
    meta?: string;
    argsPreview?: string;
    pinCommand?: string;
    input?: unknown;
  };
  result?: { ok: boolean };
  isError?: boolean;
}

type ChipStatus = "running" | "ok" | "error";

function deriveStatus(tool: ChatToolGroupItem): ChipStatus {
  if (tool.isError) return "error";
  if (tool.result) return tool.result.ok ? "ok" : "error";
  // Live snapshots before the result event lands carry the running
  // status on args; history-replayed parts always have `result` set.
  if (tool.args.status === "ok") return "ok";
  if (tool.args.status === "error") return "error";
  return "running";
}

function targetText(tool: ChatToolGroupItem): string {
  return (
    tool.args.pinCommand ||
    tool.args.meta ||
    tool.args.argsPreview ||
    ""
  );
}

export default function ChatToolGroup({ tools }: { tools: ChatToolGroupItem[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (tools.length === 0) return null;

  const statuses = tools.map(deriveStatus);
  const anyRunning = statuses.some((s) => s === "running");
  const headerLabel = anyRunning
    ? `Working · ${tools.length} tool${tools.length > 1 ? "s" : ""}`
    : `Used ${tools.length} tool${tools.length > 1 ? "s" : ""}`;

  return (
    <motion.div
      // Mount animation so the card UNFOLDS in smoothly instead of popping into
      // place mid-stream. height 0→auto means the shell grows and pushes the
      // content below it down gradually, rather than snapping a block of height
      // in at once. (Inner chips already stagger-fade — this was the missing
      // animation on the outer shell that made tools feel like they "popped".)
      // Local to this one card, so it won't reflow the rest of the message.
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
      className="rounded-2xl overflow-hidden border border-foreground/10 bg-white/40 mb-3"
      style={{
        backdropFilter: "blur(20px) saturate(1.3)",
        WebkitBackdropFilter: "blur(20px) saturate(1.3)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        {anyRunning ? (
          <Loader2
            size={11}
            strokeWidth={2.2}
            className="text-foreground/45 animate-spin"
          />
        ) : (
          <Check
            size={11}
            strokeWidth={2.5}
            className="text-foreground/45"
          />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/55 flex-1">
          {headerLabel}
        </span>
        <HeaderChevron collapsed={collapsed} />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2.5 pb-2.5 pt-1 space-y-1.5">
              {tools.map((tool, i) => (
                <ChatToolChip
                  key={tool.toolCallId}
                  tool={tool}
                  status={statuses[i]}
                  index={i}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ChatToolChip({
  tool,
  status,
  index,
}: {
  tool: ChatToolGroupItem;
  status: ChipStatus;
  /** Used to stagger the mount animation when a batch of tool-start events
   *  arrives in the same React frame (LangChain dispatches parallel tool
   *  calls in one tick → frontend batches the yields into one render →
   *  N chips otherwise pop in at once). framer-motion's `initial` only
   *  runs on mount, so a chip added later doesn't redo the animation. */
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { Icon, verb } = resolveToolPresentation(tool.toolName);
  const target = targetText(tool);
  const hasInput = isPlainObject(tool.args.input)
    ? Object.keys(tool.args.input).length > 0
    : false;
  const canExpand = status !== "running" && (Boolean(target) || hasInput);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.25,
        delay: index * 0.06,
        ease: [0.32, 0.72, 0, 1],
      }}
      className="rounded-xl bg-white/55 border border-foreground/[0.06] overflow-hidden"
    >
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-left ${
          canExpand ? "hover:bg-foreground/[0.03] cursor-pointer" : "cursor-default"
        }`}
      >
        <ToolStatusBadge Icon={Icon} status={status} />
        <p className="text-[12.5px] font-medium text-foreground/85 leading-tight truncate flex-1">
          {verb}
        </p>
        {canExpand && (
          <ChevronDown
            size={13}
            strokeWidth={1.6}
            className={`text-foreground/35 shrink-0 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-foreground/[0.06]">
              {hasInput && (
                <InputBlock input={tool.args.input as Record<string, unknown>} />
              )}
              {target && <OutputBlock text={target} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function InputBlock({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="pt-2">
      <p className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-foreground/45 mb-1">
        Input
      </p>
      <div className="rounded-lg bg-foreground/[0.03] px-2.5 py-2 space-y-1">
        {Object.entries(input).map(([k, v]) => (
          <div
            key={k}
            className="flex items-baseline gap-2 text-[11px] leading-snug"
          >
            <span className="text-foreground/45 shrink-0 font-mono">{k}</span>
            <span className="text-foreground/80 font-mono break-all">
              {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutputBlock({ text }: { text: string }) {
  return (
    <div>
      <p className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-foreground/45 mb-1">
        Output
      </p>
      <div className="rounded-lg bg-foreground/[0.03] px-2.5 py-2 text-[12px]">
        <MarkdownContent text={text} />
      </div>
    </div>
  );
}

function ToolStatusBadge({
  Icon,
  status,
}: {
  Icon: ReturnType<typeof resolveToolPresentation>["Icon"];
  status: ChipStatus;
}) {
  return (
    <div className="relative shrink-0" style={{ width: 26, height: 26 }}>
      <div
        className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center overflow-hidden border border-foreground/10"
        style={{ background: "rgba(255,255,255,0.9)" }}
      >
        <Icon size={13} strokeWidth={1.8} className="text-foreground/75" />
      </div>
      <div
        className="absolute -bottom-0.5 -right-0.5 w-[11px] h-[11px] rounded-full flex items-center justify-center border-[1.5px] border-white"
        style={{
          background:
            status === "ok"
              ? "rgb(34,197,94)"
              : status === "error"
              ? "rgb(239,68,68)"
              : "rgba(255,255,255,0.95)",
        }}
      >
        {status === "ok" ? (
          <Check size={7} className="text-white" strokeWidth={4} />
        ) : status === "error" ? (
          <AlertCircle size={7} className="text-white" strokeWidth={3} />
        ) : (
          <Loader2
            size={7}
            className="text-[hsl(304_75%_50%)] animate-spin"
            strokeWidth={3}
          />
        )}
      </div>
    </div>
  );
}

function HeaderChevron({ collapsed }: { collapsed: boolean }) {
  return collapsed ? (
    <ChevronDown
      size={14}
      strokeWidth={1.6}
      className="text-foreground/35 shrink-0"
    />
  ) : (
    <ChevronUp
      size={14}
      strokeWidth={1.6}
      className="text-foreground/35 shrink-0"
    />
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
