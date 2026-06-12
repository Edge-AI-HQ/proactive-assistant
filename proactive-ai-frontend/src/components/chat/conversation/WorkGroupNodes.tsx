/**
 * Shared rail-node rows for WorkGroup and TaskCard's nested mini-rail.
 *
 * ToolNodeRow — one tool call as a single line (status dot, verb, target);
 * tap to expand raw input/output; web-search results render as a clickable
 * favicon+title source list (favicons resolved client-side by domain).
 *
 * ThinkingNode — a reasoning span. While that span is still streaming it
 * shows a sliding tail window (the "alive" feel); settled it collapses to
 * its first line, tap for full text.
 */
import { useState } from "react";
import { AlertCircle, Check, ChevronDown, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import MarkdownContent from "@/components/chat/conversation/MarkdownContent";
import { resolveToolPresentation } from "@/components/chat/conversation/tool-presentation";
import { toolStatus, type ToolCallPart } from "@/components/chat/conversation/work-group";
import type { ToolResultLink } from "@pin-ai/core";

function faviconUrl(url: string): string | null {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return null;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function StatusDot({ status }: { status: "running" | "ok" | "error" }) {
  if (status === "ok") {
    return <Check size={11} strokeWidth={2.5} className="shrink-0 text-emerald-600" />;
  }
  if (status === "error") {
    return <AlertCircle size={11} strokeWidth={2.5} className="shrink-0 text-red-500" />;
  }
  return (
    <Loader2
      size={11}
      strokeWidth={2.2}
      className="shrink-0 animate-spin text-[hsl(304_75%_50%)]"
    />
  );
}

function LinksList({ links }: { links: ToolResultLink[] }) {
  return (
    <div className="mt-1.5 rounded-lg border border-foreground/[0.06] bg-white/60 overflow-hidden">
      {links.map((link) => {
        const icon = faviconUrl(link.url);
        return (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-foreground/[0.04] border-b border-foreground/[0.04] last:border-b-0"
          >
            {icon ? (
              <img src={icon} alt="" className="h-3.5 w-3.5 rounded-sm shrink-0" />
            ) : (
              <span className="h-3.5 w-3.5 rounded-sm bg-foreground/10 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/80">
              {link.title}
            </span>
            <span className="shrink-0 text-[10.5px] text-foreground/40">
              {domainOf(link.url)}
            </span>
          </a>
        );
      })}
    </div>
  );
}

export function ToolNodeRow({
  part,
  compact = false,
}: {
  part: ToolCallPart;
  /** Slightly tighter row inside a TaskCard's nested rail. */
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = toolStatus(part);
  const { verb } = resolveToolPresentation(part.toolName);
  const meta = part.args["meta"];
  const argsPreview = part.args["argsPreview"];
  const target =
    (typeof part.args["pinCommand"] === "string" && part.args["pinCommand"]) ||
    (typeof meta === "string" && meta) ||
    (typeof argsPreview === "string" && argsPreview) ||
    "";
  const canExpand = status !== "running" && (Boolean(target) || Boolean(part.links));

  return (
    <div>
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 text-left",
          compact ? "py-[3px]" : "py-1",
          canExpand ? "cursor-pointer hover:bg-foreground/[0.02] rounded-md" : "cursor-default",
        )}
      >
        <StatusDot status={status} />
        <span
          className={cn(
            "shrink-0 font-medium text-foreground/80",
            compact ? "text-[11.5px]" : "text-[12.5px]",
          )}
        >
          {verb}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-foreground/40",
            compact ? "text-[11px]" : "text-[11.5px]",
          )}
        >
          {typeof argsPreview === "string" ? argsPreview : ""}
        </span>
        {part.links && (
          <span className="shrink-0 text-[10.5px] text-foreground/45">
            {part.links.length} results
          </span>
        )}
        {canExpand && (
          <ChevronDown
            size={12}
            strokeWidth={1.6}
            className={cn(
              "shrink-0 text-foreground/30 transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
      {expanded && (
        <div className="pl-5 pb-1.5">
          {part.links ? (
            <LinksList links={part.links} />
          ) : (
            target && (
              <div className="mt-1 rounded-lg bg-foreground/[0.03] px-2.5 py-2 text-[12px]">
                <MarkdownContent text={String(target)} />
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

const THINKING_TAIL_CHARS = 220;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim();
}

export function ThinkingNode({
  text,
  streaming,
}: {
  text: string;
  /** This reasoning span is still receiving deltas — show the sliding tail. */
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (streaming) {
    const tail = text.slice(-THINKING_TAIL_CHARS);
    return (
      <div className="flex items-start gap-2 py-1">
        <Clock size={11} strokeWidth={2} className="mt-0.5 shrink-0 text-foreground/35" />
        <p className="min-w-0 flex-1 text-[11.5px] italic leading-snug text-foreground/45 line-clamp-2 animate-pulse">
          {tail}
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 py-1 text-left cursor-pointer hover:bg-foreground/[0.02] rounded-md"
      >
        <Clock size={11} strokeWidth={2} className="shrink-0 text-foreground/35" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] italic text-foreground/45">
          {firstLine(text) || "Thought"}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={1.6}
          className={cn(
            "shrink-0 text-foreground/30 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="pl-5 pb-1.5 text-[11.5px] italic leading-relaxed text-foreground/50 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
