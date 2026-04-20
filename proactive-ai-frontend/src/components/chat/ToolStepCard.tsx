/**
 * Renders a single tool-call content part as a compact status card.
 *
 * Tool events come from the proactive-ai backend's chat-stream:
 *   chat:tool:start  → status=running
 *   chat:tool:result → status=ok | error
 *
 * The backend already extracts a human-readable `meta`/`argsPreview` summary
 * and, for `pin` CLI invocations via the `exec` tool, a `pinCommand`
 * subcommand. This component just picks an icon, a title, and a one-line
 * detail; click to expand the full preview.
 */
import { useState } from "react";
import { ChevronDown, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const TOOL_EMOJI: Record<string, string> = {
  exec: "🛠️",
  process: "🛠️",
  code_execution: "🧪",
  browser: "🌐",
  web_search: "🔍",
  x_search: "🐦",
  web_fetch: "📥",
  read: "📄",
  write: "✍️",
  edit: "✂️",
  apply_patch: "🩹",
  message: "💬",
  image: "🖼️",
  image_generate: "🎨",
  video_generate: "🎬",
  music_generate: "🎵",
  tts: "🔈",
  canvas: "🖌️",
  cron: "⏰",
  session_status: "📊",
  sessions_list: "🗂️",
  sessions_history: "🧾",
  sessions_send: "📨",
  sessions_spawn: "🧑‍🔧",
  subagents: "🤖",
};

function prettyToolName(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

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

const ToolStepCard: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  isError,
}) => {
  const [expanded, setExpanded] = useState(false);
  const record =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const argStatus = str(record.status);
  const meta = str(record.meta);
  const argsPreview = str(record.argsPreview);
  const pinCommand = str(record.pinCommand);

  const status = deriveStatus(argStatus, result, isError);
  const emoji = TOOL_EMOJI[toolName] ?? "🧰";
  const isPinCli = Boolean(pinCommand);
  const title = isPinCli
    ? `PIN CLI · ${(pinCommand as string).split(/\s+/)[0] ?? "pin"}`
    : prettyToolName(toolName);

  const detail = pinCommand ?? meta ?? argsPreview ?? "";
  const canExpand = Boolean(detail) && detail.length > 0;

  return (
    <div
      className={cn(
        "glass-card my-1.5 px-3 py-2 text-[12px] leading-snug",
        "flex flex-col gap-1",
        status === "error" && "border-red-400/40 bg-red-50/40",
      )}
    >
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-2 text-left",
          canExpand ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span aria-hidden className="text-[14px] leading-none">
          {emoji}
        </span>
        <span
          className={cn(
            "font-semibold text-foreground/80 truncate",
            isPinCli && "text-foreground",
          )}
        >
          {title}
        </span>
        {detail && (
          <span className="text-foreground/50 truncate flex-1 min-w-0">
            {detail}
          </span>
        )}
        <span className="shrink-0 flex items-center gap-1">
          {status === "running" && (
            <Loader2 size={12} className="animate-spin text-foreground/50" />
          )}
          {status === "ok" && (
            <CheckCircle2 size={12} className="text-emerald-500" />
          )}
          {status === "error" && (
            <AlertCircle size={12} className="text-red-500" />
          )}
          {canExpand && (
            <ChevronDown
              size={12}
              className={cn(
                "text-foreground/40 transition-transform",
                expanded && "rotate-180",
              )}
            />
          )}
        </span>
      </button>
      {expanded && detail && (
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/60 bg-foreground/5 rounded-lg px-2 py-1.5">
          {detail}
        </pre>
      )}
    </div>
  );
};

export default ToolStepCard;
