/**
 * EventsFeed — vertical, now-anchored realtime stream for the L1 event stream.
 *
 * Convention: this is a live activity feed (Twitter/Slack/Datadog live-tail
 * shape), NOT a horizontal swimlane timeline. Time runs top→down descending:
 * future above the now-line, newest-past just below it, older past further down.
 * New events land at the now-line and push history down — you watch the top for
 * the latest, scroll down for history.
 *
 * react-virtuoso carries the hard parts (virtual scroll for 400+ rows, now
 * anchoring via initialTopMostItemIndex, stable keys so realtime prepends don't
 * jump). We only write the row + now-line visuals, in the zebra light-glass
 * language (frosted white + dark --foreground text + per-type accent color).
 */
import { useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { EventItem } from "@pin-ai/core";

/** event_type swimlane/legend order — heaviest structural prior first. */
export const EVENT_TYPES = [
  "transaction",
  "meeting",
  "communication",
  "preference",
  "world_news",
  "interaction",
  "agent_decision",
  "movement",
  "device_state",
  "utterance",
] as const;

export const EVENT_TYPE_LABEL: Record<string, string> = {
  transaction: "Transaction",
  meeting: "Meeting",
  communication: "Comms",
  preference: "Preference",
  world_news: "World",
  interaction: "Interaction",
  agent_decision: "Agent",
  movement: "Movement",
  device_state: "Device",
  utterance: "Voice",
};

/** Per-type accent color (was EventsTimeline.css `.et-<type>`). */
export const EVENT_TYPE_COLOR: Record<string, string> = {
  transaction: "#d97706", // amber-600
  meeting: "#2563eb", // blue-600
  communication: "#16a34a", // green-600
  preference: "#9333ea", // purple-600
  world_news: "#0891b2", // cyan-600
  interaction: "#0d9488", // teal-600
  agent_decision: "#db2777", // pink-600
  movement: "#ea580c", // orange-600
  device_state: "#64748b", // slate-500
  utterance: "#475569", // slate-600
};

const FALLBACK_COLOR = "#475569";

/** One-line label. Generic across all sources — no event_type special-casing.
 *  Convention: title is a one-line summary, body is detail; whichever carries
 *  content shows. Which is populated depends on the source (gmail→title,
 *  chat→body, utterance→body). Full text lives in the detail panel. */
export function eventLabel(e: EventItem): string {
  const text = e.title?.trim() || e.body?.trim() || EVENT_TYPE_LABEL[e.eventType] || e.eventType;
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

/** Relative time vs now — "in 3h" (future) / "5m ago" (past). */
function relTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = t - now;
  const s = Math.round(Math.abs(diff) / 1000);
  const unit =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.round(s / 60)}m`
        : s < 86_400
          ? `${Math.round(s / 3600)}h`
          : `${Math.round(s / 86_400)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** now-line sentinel woven into the item list at the past/future boundary. */
export const NOW_MARKER = { __now: true } as const;
export type FeedItem = EventItem | typeof NOW_MARKER;

function isNow(item: FeedItem): item is typeof NOW_MARKER {
  return "__now" in item;
}

interface Props {
  items: FeedItem[];
  /** index of NOW_MARKER — virtuoso anchors the initial viewport here. */
  nowIndex: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function EventsFeed({ items, nowIndex, selectedId, onSelect }: Props) {
  const now = Date.now();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Rendered row range — drives the "Now" jump pill (shown only while the
  // now-line is out of view). Initial null = in view (the initial anchor
  // centers it), so the pill never flashes on mount.
  const [range, setRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const nowInView = range === null || (nowIndex >= range.startIndex && nowIndex <= range.endIndex);
  return (
    <>
      <Virtuoso
        ref={virtuosoRef}
        className="h-full w-full"
        data={items}
        // Anchor the FIRST viewport on the now-line, centered — the mount-time
        // one-shot; ZebraEvents only mounts the feed once both query sides have
        // landed so nowIndex is final by then (a late prepend would silently
        // shift this anchor: initialTopMostItemIndex never re-fires).
        initialTopMostItemIndex={{ index: nowIndex, align: "center" }}
        rangeChanged={setRange}
        computeItemKey={(_, item) => (isNow(item) ? "__now__" : item.id)}
        itemContent={(_, item) => {
          if (isNow(item)) return <NowLine />;
          const color = EVENT_TYPE_COLOR[item.eventType] ?? FALLBACK_COLOR;
          const active = item.id === selectedId;
          return (
            <button
              type="button"
              onClick={() => onSelect(active ? null : item.id)}
              className={`flex w-full items-start gap-3 border-b border-foreground/5 px-4 py-2.5 text-left transition-colors hover:bg-white/40 ${
                active ? "bg-white/55" : ""
              }`}
            >
              <span
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white/70"
                style={{ background: color }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm leading-snug text-foreground/85">
                  {eventLabel(item)}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-foreground/40">
                  <span style={{ color }}>
                    {EVENT_TYPE_LABEL[item.eventType] ?? item.eventType}
                  </span>
                  <span>·</span>
                  <span>{relTime(item.occurredAt, now)}</span>
                  {!item.curatedAt && <span className="text-amber-600/70">· pending</span>}
                </div>
              </div>
            </button>
          );
        }}
      />
      {!nowInView && range !== null && (
        <button
          type="button"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({
              index: nowIndex,
              align: "center",
              behavior: "smooth",
            })
          }
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-rose-500 px-3 py-1 text-[11px] font-semibold tracking-wide text-white shadow-md transition-colors hover:bg-rose-600"
        >
          {nowIndex < range.startIndex ? "↑ Now" : "↓ Now"}
        </button>
      )}
    </>
  );
}

function NowLine() {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <span className="h-px flex-1 bg-rose-500/50" />
      <span className="rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white shadow-sm">
        NOW
      </span>
      <span className="h-px flex-1 bg-rose-500/50" />
    </div>
  );
}
