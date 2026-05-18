/**
 * Claude-style tool activity row for MainChatView.
 *
 * Renders a single tool-call content part as a compact, inline activity line:
 *   <icon>  <verb>  <target>  <status>
 *
 * Tap to expand full detail. Running state shows a left accent bar.
 */
import { useState } from "react";
import {
  ChevronDown,
  Loader2,
  Check,
  AlertCircle,
  Terminal,
  Globe,
  Search,
  Download,
  FileText,
  PenLine,
  Scissors,
  FileEdit,
  MessageSquare,
  Image as ImageIcon,
  Paintbrush,
  Music,
  Video,
  Volume2,
  Clock,
  Database,
  List,
  Send,
  UserCog,
  Bot,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import ProposeActionCard from "./ProposeActionCard";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

interface ToolPresentation {
  Icon: LucideIcon;
  verb: string;
}

const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  exec: { Icon: Terminal, verb: "Ran" },
  process: { Icon: Terminal, verb: "Ran" },
  code_execution: { Icon: Terminal, verb: "Executed" },
  browser: { Icon: Globe, verb: "Browsed" },
  web_search: { Icon: Search, verb: "Searched" },
  x_search: { Icon: Search, verb: "Searched X" },
  web_fetch: { Icon: Download, verb: "Fetched" },
  read: { Icon: FileText, verb: "Read" },
  write: { Icon: PenLine, verb: "Wrote" },
  edit: { Icon: Scissors, verb: "Edited" },
  apply_patch: { Icon: FileEdit, verb: "Patched" },
  message: { Icon: MessageSquare, verb: "Messaged" },
  image: { Icon: ImageIcon, verb: "Read image" },
  image_generate: { Icon: Paintbrush, verb: "Generated image" },
  video_generate: { Icon: Video, verb: "Generated video" },
  music_generate: { Icon: Music, verb: "Generated music" },
  tts: { Icon: Volume2, verb: "Spoke" },
  canvas: { Icon: Paintbrush, verb: "Drew" },
  cron: { Icon: Clock, verb: "Scheduled" },
  session_status: { Icon: Database, verb: "Checked session" },
  sessions_list: { Icon: List, verb: "Listed sessions" },
  sessions_history: { Icon: List, verb: "Loaded history" },
  sessions_send: { Icon: Send, verb: "Sent" },
  sessions_spawn: { Icon: UserCog, verb: "Spawned agent" },
  subagents: { Icon: Bot, verb: "Delegated to agent" },
};

function deriveStatus(
  argStatus: string | undefined,
  result: unknown,
  isError: boolean | undefined,
): "running" | "ok" | "error" {
  const resultOk =
    result && typeof result === "object" && "ok" in result
      ? (result as { ok?: unknown }).ok
      : undefined;
  if (isError || resultOk === false) return "error";
  if (resultOk === true) return "ok";
  if (argStatus === "ok" || argStatus === "error" || argStatus === "running") {
    return argStatus;
  }
  return "running";
}

function resolvePresentation(toolName: string): ToolPresentation {
  return (
    TOOL_PRESENTATION[toolName] ?? {
      Icon: Wrench,
      verb: toolName.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    }
  );
}

const ToolActivityCard: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  isError,
}) => {
  // `propose_action` is the card-execution agent's structured-pause
  // channel — it carries chip / draft / plan payload that we render
  // as a dedicated NEEDS YOUR INPUT panel instead of the generic
  // "tool ran" activity row. Delegate to ProposeActionCard so the
  // chat-thread surface stays one-component-per-pause.
  if (toolName === "propose_action") {
    return <ProposeActionCard args={args} />;
  }

  const [expanded, setExpanded] = useState(false);
  const record =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const argStatus = str(record.status);
  const meta = str(record.meta);
  const argsPreview = str(record.argsPreview);
  const pinCommand = str(record.pinCommand);

  const status = deriveStatus(argStatus, result, isError);
  const isPinCli = Boolean(pinCommand);
  const { Icon, verb } = isPinCli
    ? { Icon: Terminal, verb: "Ran" }
    : resolvePresentation(toolName);
  const target = pinCommand ?? meta ?? argsPreview ?? "";
  const canExpand = Boolean(target) && target.length > 0;

  const statusColor =
    status === "running"
      ? "border-l-blue-400/60"
      : status === "error"
      ? "border-l-red-400/70"
      : "border-l-transparent";

  return (
    <div
      className={cn(
        "my-1 rounded-md border-l-2 bg-foreground/[0.03] text-[12px] leading-snug",
        "transition-colors",
        statusColor,
        status === "error" && "bg-red-50/50",
      )}
    >
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 text-left",
          canExpand ? "cursor-pointer" : "cursor-default",
        )}
      >
        <Icon
          size={13}
          strokeWidth={1.8}
          className={cn(
            "shrink-0",
            status === "running"
              ? "text-blue-500/80"
              : status === "error"
              ? "text-red-500/80"
              : "text-foreground/50",
          )}
        />
        <span className="font-medium text-foreground/75 shrink-0">{verb}</span>
        {target && (
          <span className="font-mono text-[11px] text-foreground/50 truncate flex-1 min-w-0">
            {target}
          </span>
        )}
        <span className="shrink-0 flex items-center gap-1 text-foreground/40">
          {status === "running" && (
            <Loader2 size={12} className="animate-spin text-blue-500/70" />
          )}
          {status === "ok" && <Check size={12} className="text-emerald-500/80" />}
          {status === "error" && (
            <AlertCircle size={12} className="text-red-500/80" />
          )}
          {canExpand && (
            <ChevronDown
              size={12}
              className={cn(
                "transition-transform",
                expanded && "rotate-180",
              )}
            />
          )}
        </span>
      </button>
      {expanded && target && (
        <pre className="mx-2.5 mb-2 mt-0 whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/60 bg-foreground/5 rounded px-2 py-1.5">
          {target}
        </pre>
      )}
    </div>
  );
};

export default ToolActivityCard;
