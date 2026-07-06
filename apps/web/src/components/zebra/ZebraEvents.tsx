/**
 * Desktop (zebra) EVENTS — the L1 event stream as a now-anchored realtime feed.
 *
 * Web-only surface (mounted by ZebraShell, not exposed in the capacitor / mobile
 * navs). Vertical live feed (EventsFeed / virtuoso): future above the now-line,
 * newest-past just below it, older past scrolling down — you watch the top for
 * the latest. Realtime = SSE signal plane (useEventsLiveRefresh invalidates on
 * each pai_events write) + a slow fallback poll; the now-line is a CLIENT-side
 * tick boundary (30s), decoupled from the query keys so it moves without ever
 * churning the cache.
 *
 * Query shape (the load-bearing bit): `recent` has NO time filter — newest 200
 * by occurredAt DESC — so a freshly ingested event is always inside its window
 * (an `until=mount` bound would orphan everything ingested after mount, and a
 * DESC `since=mount` window truncates NEAREST-first once ambient outgrows the
 * limit — the two dead ends this shape replaces). `future` (since=mount, slow
 * poll) only guards the far tail: upcoming events pushed out of recent's 200
 * cap by newer rows. Merge dedupes by id, sorts DESC, and splits at the tick.
 * Per-type legend filter + click-to-inspect detail panel. Zebra light-glass
 * language (frosted white + dark --foreground text + per-type accent color).
 */
import { useEffect, useMemo, useState } from "react";
import { useEvents, useEventsLiveRefresh } from "@pin-ai/state";
import type { EventItem } from "@pin-ai/core";
import EventsFeed, {
  EVENT_TYPES,
  EVENT_TYPE_LABEL,
  EVENT_TYPE_COLOR,
  NOW_MARKER,
  type FeedItem,
} from "./EventsFeed";

/** Fallback poll — SSE is the primary freshness channel; this only covers
 * signal-plane gaps (dropped LISTEN, mark_curated which doesn't notify). */
const RECENT_POLL_MS = 60_000;
const FUTURE_POLL_MS = 300_000;
/** now-line boundary tick — also refreshes the rows' relative timestamps. */
const TICK_MS = 30_000;
const FALLBACK_COLOR = "#64748b";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function ZebraEvents() {
  // Mount instant — only the far-future guard query anchors on it; the
  // now-line boundary is the live tick below, NOT this (a frozen boundary
  // was why fresh events used to land above the line marked "2m ago").
  const mountISO = useMemo(() => new Date().toISOString(), []);
  const recent = useEvents({ limit: 200 }, true, RECENT_POLL_MS);
  const future = useEvents({ since: mountISO, limit: 200 }, true, FUTURE_POLL_MS);

  // SSE signal plane: every pai_events write invalidates both queries above —
  // a fresh ambient event shows up within ~1s of landing in L1.
  useEventsLiveRefresh(true);

  // Live now-line: re-splits the merged list every 30s so the boundary drifts
  // with wall-clock time (a just-ended meeting slides below the line) and the
  // rows' relative timestamps re-render. Pure client state — query keys never
  // change, so the tick costs zero network and zero cache churn.
  const [tickMs, setTickMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTickMs(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  // Data arrival also advances the boundary: a just-ingested event's
  // occurredAt sits between the last tick and now, and would otherwise render
  // ABOVE the line as "0s ago upcoming" until the next tick. Structural
  // sharing keeps the reference stable on no-op refetches, so this only fires
  // on real changes.
  useEffect(() => {
    setTickMs(Date.now());
  }, [recent.events]);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Gate the feed until BOTH sides land: EventsFeed's center-on-now anchor is
  // a mount-time one-shot, so mounting on partial data would lock a stale
  // nowIndex and leave the viewport parked at the top of the future block
  // (the "opens on the farthest future event" bug).
  const loading =
    (recent.loading && recent.events.length === 0) ||
    (future.loading && future.events.length === 0);
  const error = recent.error ?? future.error;

  // Merge both queries (they overlap by design), dedupe by id, global
  // occurredAt DESC — future's farthest at the top, oldest past at the bottom.
  const allEvents = useMemo(() => {
    const byId = new Map<string, EventItem>();
    for (const e of [...recent.events, ...future.events]) byId.set(e.id, e);
    return [...byId.values()].sort(
      (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
    );
  }, [recent.events, future.events]);

  // Feed items: split the DESC list at the tick boundary and weave NOW in.
  // Realtime: a fresh event (occurredAt ≈ now) lands just under the line and
  // pushes history down; when the tick passes an upcoming event's time, only
  // it and the marker swap places — every other row's index is untouched.
  const { items, nowIndex } = useMemo(() => {
    const visible = allEvents.filter((e) => !hidden.has(e.eventType));
    const split = visible.findIndex((e) => Date.parse(e.occurredAt) <= tickMs);
    const boundary = split === -1 ? visible.length : split;
    return {
      items: [
        ...visible.slice(0, boundary),
        NOW_MARKER,
        ...visible.slice(boundary),
      ] as FeedItem[],
      nowIndex: boundary,
    };
  }, [allEvents, hidden, tickMs]);

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
          {items.length - 1 - nowIndex} past · {nowIndex} upcoming
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
