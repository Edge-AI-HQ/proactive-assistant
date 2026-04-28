import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  deviceMediaUrl,
  fetchSignals,
  type PersonalSignal,
  type UserDevice,
} from "@/lib/api";

const PAGE_SIZE = 30;

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
  // First page returns a real total; subsequent (cursor) pages return -1
  // because the server skips the COUNT(*) cost. Keep whatever we last saw.
  const [total, setTotal] = useState<number | null>(null);
  const cursorRef = useRef<string | null>(null);

  const loadPage = useCallback(
    async (reset: boolean = false) => {
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const before = reset ? null : cursorRef.current;
        const { signals: batch, total, next_cursor, has_more } = await fetchSignals({
          deviceId: device.device_id,
          status: "all",
          limit: PAGE_SIZE,
          ...(before ? { before } : {}),
        });
        setSignals((prev) => (reset ? batch : [...prev, ...batch]));
        if (typeof total === "number" && total >= 0) setTotal(total);
        cursorRef.current = next_cursor;
        setHasMore(Boolean(has_more));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [device.device_id, loading],
  );

  // Reset when device changes.
  useEffect(() => {
    cursorRef.current = null;
    setSignals([]);
    setTotal(null);
    setHasMore(true);
    void loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.device_id]);

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
            Load more
          </button>
        ) : signals.length > 0 ? (
          <div className="text-[10px] text-foreground/30">— end —</div>
        ) : null}
      </div>
    </div>
  );
}

// ── Single row renderer ─────────────────────────────────────────────────

function SignalRow({ signal }: { signal: PersonalSignal }) {
  const filePath = useMemo(() => {
    const fp = (signal.payload as { file_path?: unknown }).file_path;
    return typeof fp === "string" && fp.length > 0 ? fp : null;
  }, [signal.payload]);

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

      {mediaKind === "image" && filePath && (
        <img
          src={deviceMediaUrl(filePath)}
          alt={signal.title}
          loading="lazy"
          className="w-full max-h-80 object-contain rounded-md bg-foreground/5"
        />
      )}

      {mediaKind === "video" && filePath && (
        <video
          src={deviceMediaUrl(filePath)}
          controls
          preload="metadata"
          className="w-full max-h-80 rounded-md bg-foreground/5"
        />
      )}

      {mediaKind === "audio" && filePath && (
        <audio
          src={deviceMediaUrl(filePath)}
          controls
          preload="metadata"
          className="w-full"
        />
      )}

      {mediaKind === "file" && filePath && (
        <a
          href={deviceMediaUrl(filePath)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary underline break-all"
        >
          Download {filePath.split("/").pop()}
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
