import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  deviceMediaUrl,
  fetchSignals,
  type PersonalSignal,
  type UserDevice,
} from "@/lib/api";
import {
  DEVICE_TIMELINE_QUICK_FILTERS,
  formatLocalDateInput,
  getDeviceTimelineDateRange,
  type DeviceTimelineDayFilter,
} from "@/lib/deviceTimelineFilters";

const PAGE_SIZE = 10;

interface DeviceTimelineProps {
  device: UserDevice;
  onBack: () => void;
}

/**
 * Timeline waterfall for a single device. Pulls personal_signals filtered
 * by deviceId, descending by occurred_at, with keyset (cursor) pagination.
 * Items carrying file_path render as image / video / audio inline; other
 * items fall back to summary text.
 */
export default function DeviceTimeline({ device, onBack }: DeviceTimelineProps) {
  const [signals, setSignals] = useState<PersonalSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [dayFilter, setDayFilter] = useState<DeviceTimelineDayFilter>("all");
  const [customDay, setCustomDay] = useState(() => formatLocalDateInput(new Date()));
  // First page returns a real total; subsequent (cursor) pages return -1
  // because the server skips the COUNT(*) cost. Keep whatever we last saw.
  const [total, setTotal] = useState<number | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const requestSeqRef = useRef(0);

  const dateRange = useMemo(
    () => getDeviceTimelineDateRange(dayFilter, customDay),
    [customDay, dayFilter],
  );

  const loadPage = useCallback(
    async (reset: boolean = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      const requestSeq = requestSeqRef.current;
      try {
        const before = reset ? null : cursorRef.current;
        const { signals: batch, total, next_cursor, has_more } = await fetchSignals({
          deviceId: device.device_id,
          status: "all",
          limit: PAGE_SIZE,
          ...(dateRange.since ? { since: dateRange.since } : {}),
          ...(dateRange.until ? { until: dateRange.until } : {}),
          ...(before ? { before } : {}),
        });
        if (requestSeq !== requestSeqRef.current) return;
        setSignals((prev) => (reset ? batch : [...prev, ...batch]));
        if (typeof total === "number" && total >= 0) setTotal(total);
        cursorRef.current = next_cursor;
        setHasMore(Boolean(has_more));
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestSeq === requestSeqRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [dateRange.since, dateRange.until, device.device_id],
  );

  // Reset when device or day filter changes.
  useEffect(() => {
    requestSeqRef.current += 1;
    loadingRef.current = false;
    cursorRef.current = null;
    setSignals([]);
    setTotal(null);
    setHasMore(true);
    void loadPage(true);
  }, [loadPage]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="text-foreground/60 hover:text-foreground transition flex items-center gap-1 text-xs"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">
            {device.display_name ?? device.device_id}
          </div>
          <div className="text-[10px] text-foreground/40 truncate">
            {device.platform}
            {device.model ? ` · ${device.model}` : ""}
            {total !== null
              ? ` · ${total} item${total === 1 ? "" : "s"}`
              : signals.length > 0
                ? ` · ${signals.length}+ loaded`
                : ""}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          {DEVICE_TIMELINE_QUICK_FILTERS.map((option) => (
            <button
              key={option.value}
              onClick={() => setDayFilter(option.value)}
              className={`min-h-8 rounded-full border px-3 text-[11px] transition ${
                dayFilter === option.value
                  ? "border-foreground/80 bg-foreground/85 text-background"
                  : "border-foreground/10 text-foreground/55 hover:border-foreground/25 hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.025] p-1.5">
          <input
            aria-label="Filter by day"
            type="date"
            value={customDay}
            onChange={(event) => {
              setCustomDay(event.target.value);
              setDayFilter("custom");
            }}
            className="min-h-8 min-w-0 rounded-lg border border-transparent bg-transparent px-2 text-xs text-foreground/70 outline-none transition hover:bg-background/60 focus:border-foreground/20 focus:bg-background/80"
          />
          <div className="min-w-[72px] shrink-0 text-right text-[10px] leading-tight text-foreground/40">
            <div>{dateRange.label}</div>
            <div>{signals.length}{total !== null ? ` / ${total}` : ""} shown</div>
          </div>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-500/80 px-2 py-1.5 rounded bg-red-500/10">
          {error}
        </div>
      )}

      {signals.length === 0 && !loading && !error && (
        <div className="text-xs text-foreground/40 px-2 py-8 text-center">
          No data yet from this device.
        </div>
      )}

      <ul className="space-y-2">
        {signals.map((sig) => (
          <SignalRow key={sig.id} signal={sig} />
        ))}
      </ul>

      <div className="flex justify-center pt-2">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-foreground/50">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : hasMore ? (
          <button
            onClick={() => void loadPage(false)}
            className="text-xs text-foreground/60 hover:text-foreground px-3 py-1.5 rounded-md border border-foreground/10 hover:border-foreground/30 transition"
          >
            Load 10 more
          </button>
        ) : signals.length > 0 ? (
          <div className="text-[10px] text-foreground/30">— end —</div>
        ) : null}
      </div>
    </div>
  );
}

// ── Single row renderer ─────────────────────────────────────────────────

// Resolve the signed URL for a storage_path lazily — pinai-agents only
// hands out TTL-bounded URLs, so we don't bake a permanent URL into
// the row at render time.
function useDeviceMediaUrl(filePath: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!filePath) { setUrl(null); return; }
    let cancelled = false;
    void deviceMediaUrl(filePath).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => { cancelled = true; };
  }, [filePath]);
  return url;
}

function SignalRow({ signal }: { signal: PersonalSignal }) {
  const filePath = useMemo(() => {
    // pinai-agents writes payload.storage_path; legacy plugin wrote file_path.
    // Read both during the cutover; storage_path takes precedence.
    const p = signal.payload as { storage_path?: unknown; file_path?: unknown };
    const sp = typeof p.storage_path === "string" && p.storage_path.length > 0
      ? p.storage_path : null;
    const fp = typeof p.file_path === "string" && p.file_path.length > 0
      ? p.file_path : null;
    return sp ?? fp;
  }, [signal.payload]);

  const mediaUrl = useDeviceMediaUrl(filePath);
  const mediaKind = useMemo(() => classifyMediaKind(signal.kind, filePath), [signal.kind, filePath]);
  const occurred = useMemo(() => formatTime(signal.occurred_at), [signal.occurred_at]);

  return (
    <li className="glass-card p-3 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] text-foreground/40 tabular-nums shrink-0">{occurred}</span>
        <span className="text-[10px] text-foreground/60 px-1.5 py-0.5 rounded bg-foreground/5 shrink-0">
          {signal.kind}
        </span>
        <span className="text-xs font-medium truncate">{signal.title}</span>
      </div>

      {signal.summary && (
        <p className="text-[11px] text-foreground/60 leading-relaxed">{signal.summary}</p>
      )}

      {mediaKind === "image" && mediaUrl && (
        <img
          src={mediaUrl}
          alt={signal.title}
          loading="lazy"
          className="w-full max-h-80 object-contain rounded-md bg-foreground/5"
        />
      )}

      {mediaKind === "video" && mediaUrl && (
        <video
          src={mediaUrl}
          controls
          preload="metadata"
          className="w-full max-h-80 rounded-md bg-foreground/5"
        />
      )}

      {mediaKind === "audio" && mediaUrl && (
        <audio
          src={mediaUrl}
          controls
          preload="metadata"
          className="w-full"
        />
      )}

      {mediaKind === "file" && mediaUrl && (
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary underline break-all"
        >
          Download {filePath?.split("/").pop()}
        </a>
      )}
    </li>
  );
}

type MediaKind = "image" | "video" | "audio" | "file" | null;

function classifyMediaKind(kind: string, filePath: string | null): MediaKind {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  if (kind.includes("image") || /\.(jpe?g|png|gif|webp)$/.test(lower)) return "image";
  if (kind.includes("video") || /\.(mp4|mov|webm)$/.test(lower)) return "video";
  if (kind.includes("audio") || /\.(opus|ogg|mp3|wav|m4a)$/.test(lower)) return "audio";
  return "file";
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
