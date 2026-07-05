/**
 * Desktop (zebra) EVENTS — the L1 event stream as a now-anchored realtime feed.
 *
 * Web-only surface (mounted by ZebraShell, not exposed in the capacitor / mobile
 * navs). Vertical live feed (EventsFeed / virtuoso): future above the now-line,
 * newest-past just below it, older past scrolling down — you watch the top for
 * the latest. Two useEvents queries anchor on now (past: until=now / future:
 * since=now) so we get ~200 each side instead of a single 200-by-recency cap.
 * Per-type legend filter + click-to-inspect detail panel. Zebra light-glass
 * language (frosted white + dark --foreground text + per-type accent color).
 */
import { useMemo, useState } from "react";
import { useEvents } from "@pin-ai/state";
import type { EventItem } from "@pin-ai/core";
import EventsFeed, {
  EVENT_TYPES,
  EVENT_TYPE_LABEL,
  EVENT_TYPE_COLOR,
  NOW_MARKER,
  type FeedItem,
} from "./EventsFeed";

const POLL_MS = 10_000;
const FALLBACK_COLOR = "#64748b";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function ZebraEvents() {
  // now fixed at mount so the two queries share one boundary (polls refresh
  // rows, not the anchor). past = newest 200 before now; future = events after
  // now (few — meetings / predicted.*; one DESC pull catches them all).
  const nowISO = useMemo(() => new Date().toISOString(), []);
  const past = useEvents({ until: nowISO, limit: 200 }, true, POLL_MS);
  const future = useEvents({ since: nowISO, limit: 200 }, true, POLL_MS * 6);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loading = past.loading && past.events.length === 0;
  const error = past.error ?? future.error;

  // both sides for legend presence + detail lookup.
  const allEvents = useMemo(
    () => [...future.events, ...past.events],
    [future.events, past.events],
  );

  // feed items, top→down time-descending: future (DESC) · NOW · past (DESC).
  // Both sides already return occurred_at DESC, so no reverse — future's
  // farthest sits at the top and its nearest touches NOW; past's nearest touches
  // NOW and its oldest sits at the bottom. Realtime: a new past event lands at
  // pastV[0] (just under NOW) and pushes history down.
  const { items, nowIndex } = useMemo(() => {
    const visible = (e: EventItem) => !hidden.has(e.eventType);
    const futureV = future.events.filter(visible);
    const pastV = past.events.filter(visible);
    return {
      items: [...futureV, NOW_MARKER, ...pastV] as FeedItem[],
      nowIndex: futureV.length,
    };
  }, [future.events, past.events, hidden]);

  const selected: EventItem | null = useMemo(
    () => allEvents.find((e) => e.id === selectedId) ?? null,
    [allEvents, selectedId],
  );

  // which types actually appear (for the legend) — declared order first.
  const presentTypes = useMemo(() => {
    const set = new Set(allEvents.map((e) => e.eventType));
    const known = EVENT_TYPES.filter((t) => set.has(t));
    const unknown = [...set].filter((t) => !EVENT_TYPES.includes(t as never));
    return [...known, ...unknown];
  }, [allEvents]);

  const toggleType = (t: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <div className="flex h-full w-full flex-col gap-3 px-6 py-5">
      {/* ── header ── */}
      <div className="flex items-baseline gap-2">
        <h1 className="text-base font-semibold tracking-tight text-foreground">Events</h1>
        <span className="text-xs text-muted-foreground">
          {past.events.length} past · {future.events.length} upcoming
        </span>
      </div>

      {/* ── legend / type filter ── */}
      {presentTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presentTypes.map((t) => {
            const on = !hidden.has(t);
            const color = EVENT_TYPE_COLOR[t] ?? FALLBACK_COLOR;
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                  on
                    ? "border-foreground/10 bg-white/60 text-foreground/75 hover:bg-white/80"
                    : "border-foreground/5 bg-white/20 text-foreground/30"
                }`}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: on ? color : "transparent",
                    border: `1px solid ${color}`,
                  }}
                />
                {EVENT_TYPE_LABEL[t] ?? t.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      )}

      {/* ── feed + detail ── */}
      <div className="relative flex-1 overflow-hidden rounded-2xl border border-foreground/10 bg-white/30 shadow-sm backdrop-blur-xl">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading events…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-rose-600">{error}</div>
        ) : items.length <= 1 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No events yet.
          </div>
        ) : (
          <EventsFeed
            items={items}
            nowIndex={nowIndex}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}

        {/* detail panel (slide-over) */}
        {selected && (
          <div className="absolute right-0 top-0 flex h-full w-80 flex-col gap-2 overflow-y-auto border-l border-foreground/10 bg-white/75 p-4 shadow-lg backdrop-blur-xl">
            <div className="flex items-start justify-between gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  color: EVENT_TYPE_COLOR[selected.eventType] ?? "#475569",
                  backgroundColor: `${EVENT_TYPE_COLOR[selected.eventType] ?? "#475569"}1f`,
                }}
              >
                {EVENT_TYPE_LABEL[selected.eventType] ?? selected.eventType}
              </span>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="text-foreground/40 hover:text-foreground/80"
              >
                ✕
              </button>
            </div>
            <h2 className="text-sm font-semibold text-foreground">{selected.title ?? "(untitled)"}</h2>
            {selected.body && (
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/60">
                {selected.body}
              </p>
            )}
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-foreground/55">
              <dt className="text-foreground/40">Occurred</dt>
              <dd>{fmt(selected.occurredAt)}</dd>
              {selected.endAt && (
                <>
                  <dt className="text-foreground/40">Ended</dt>
                  <dd>{fmt(selected.endAt)}</dd>
                </>
              )}
              <dt className="text-foreground/40">Recorded</dt>
              <dd>{fmt(selected.recordedAt)}</dd>
              <dt className="text-foreground/40">Curation</dt>
              <dd>{selected.curatedAt ? "curated" : "pending (evolve queue)"}</dd>
              <dt className="text-foreground/40">Source</dt>
              <dd>{selected.source}</dd>
              <dt className="text-foreground/40">References</dt>
              <dd>{selected.referenceCount}</dd>
            </dl>
            {Object.keys(selected.structured).length > 0 && (
              <pre className="mt-1 overflow-x-auto rounded bg-foreground/5 p-2 text-[10px] leading-relaxed text-foreground/55">
                {JSON.stringify(selected.structured, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
