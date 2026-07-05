import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Activity, Loader2 } from "lucide-react";
import { deviceMediaUrl, fetchDeviceTimeline, type DeviceContextRow, type DeviceHealthObservation, type DeviceTimelineItem, type UserDevice } from "@pin-ai/core";
import {
  DEVICE_TIMELINE_QUICK_FILTERS,
  formatLocalDateInput,
  getDeviceTimelineDateRange,
  type DeviceTimelineDayFilter,
} from "@pin-ai/core";
import { Text } from "../primitives/Text";

const PAGE_SIZE = 10;

interface DeviceTimelineProps {
  device: UserDevice;
  onBack: () => void;
}

/**
 * Timeline waterfall for a single device. Pulls the unified
 * ``/api/devices/{deviceId}/timeline`` endpoint which returns the device's
 * `pai_raw` rows server-side, ordered by occurred_at DESC, with a single keyset
 * cursor. Each item's `type` is the row's entity_type: `health` rows render via
 * HealthRow; every other ambient / device context bucket (utterance / visit /
 * calendar / motion / focus / transcript_window / context) renders via
 * ContextRow (kind + media).
 *
 * Date filters from the frontend filter chips are applied client-side
 * post-fetch to avoid plumbing since/until into the new endpoint — the
 * per-day windows are small (≤ a week of data) so this is cheap.
 */
export default function DeviceTimeline({ device, onBack }: DeviceTimelineProps) {
  const { t } = useTranslation(["connect", "common"]);
  const [items, setItems] = useState<DeviceTimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [dayFilter, setDayFilter] = useState<DeviceTimelineDayFilter>("all");
  const [customDay, setCustomDay] = useState(() => formatLocalDateInput(new Date()));
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const requestSeqRef = useRef(0);

  const dateRange = useMemo(
    () => getDeviceTimelineDateRange(dayFilter, customDay),
    [customDay, dayFilter],
  );

  const inDateRange = useCallback(
    (occurredIso: string): boolean => {
      const t = Date.parse(occurredIso);
      if (!Number.isFinite(t)) return true;
      if (dateRange.since) {
        const since = Date.parse(dateRange.since);
        if (Number.isFinite(since) && t < since) return false;
      }
      if (dateRange.until) {
        const until = Date.parse(dateRange.until);
        if (Number.isFinite(until) && t > until) return false;
      }
      return true;
    },
    [dateRange.since, dateRange.until],
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
        const { items: batch, next_cursor, has_more } = await fetchDeviceTimeline(
          device.device_id,
          { before, limit: PAGE_SIZE },
        );
        if (requestSeq !== requestSeqRef.current) return;
        // Client-side date filter — server returns newest-first regardless
        // of dayFilter so the filter chips stay snappy without round-trips.
        const filtered = batch.filter((it) => inDateRange(it.occurred_at));
        setItems((prev) => (reset ? filtered : [...prev, ...filtered]));
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
    [device.device_id, inDateRange],
  );

  // Reset when device or day filter changes.
  useEffect(() => {
    requestSeqRef.current += 1;
    loadingRef.current = false;
    cursorRef.current = null;
    setItems([]);
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
          <ArrowLeft size={14} /> {t("deviceTimeline.back")}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">
            {device.display_name ?? device.device_id}
          </div>
          <div className="text-micro text-foreground/40 truncate">
            {device.platform}
            {device.model ? ` · ${device.model}` : ""}
            {items.length > 0
              ? ` · ${t("deviceTimeline.loaded", { count: `${items.length}${hasMore ? "+" : ""}` })}`
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
              className={`min-h-8 rounded-full border px-3 text-caption transition ${
                dayFilter === option.value
                  ? "border-foreground/80 bg-foreground/85 text-background"
                  : "border-foreground/10 text-foreground/55 hover:border-foreground/25 hover:text-foreground"
              }`}
            >
              {t(`deviceTimeline.filters.${option.value}`)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.025] p-1.5">
          <input
            aria-label={t("deviceTimeline.filterByDay")}
            type="date"
            value={customDay}
            onChange={(event) => {
              setCustomDay(event.target.value);
              setDayFilter("custom");
            }}
            className="min-h-8 min-w-0 rounded-lg border border-transparent bg-transparent px-2 text-xs text-foreground/70 outline-none transition hover:bg-background/60 focus:border-foreground/20 focus:bg-background/80"
          />
          <div className="min-w-[72px] shrink-0 text-right text-micro leading-tight text-foreground/40">
            <div>{dateRange.label}</div>
            <div>{t("deviceTimeline.shownCount", { count: items.length })}</div>
          </div>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-500/80 px-2 py-1.5 rounded bg-red-500/10">
          {error}
        </div>
      )}

      {items.length === 0 && !loading && !error && (
        <div className="text-xs text-foreground/40 px-2 py-8 text-center">
          {t("deviceTimeline.emptyTimeline")}
        </div>
      )}

      <ul className="space-y-2">
        {items.map((it) =>
          // `type` is the row's entity_type: `health` → HealthRow, every other
          // ambient / device context bucket → ContextRow. The row union can't
          // be narrowed on the open entity_type set, so assert per branch.
          it.type === "health" ? (
            <HealthRow key={`h-${it.row.id}`} obs={it.row as DeviceHealthObservation} />
          ) : (
            <ContextRow key={`c-${it.row.id}`} row={it.row as DeviceContextRow} entityType={it.type} />
          ),
        )}
      </ul>

      <div className="flex justify-center pt-2">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-foreground/50">
            <Loader2 size={12} className="animate-spin" /> {t("common:status.loading")}
          </div>
        ) : hasMore ? (
          <button
            onClick={() => void loadPage(false)}
            className="text-xs text-foreground/60 hover:text-foreground px-3 py-1.5 rounded-md border border-foreground/10 hover:border-foreground/30 transition"
          >
            {t("deviceTimeline.loadMore", { count: PAGE_SIZE })}
          </button>
        ) : items.length > 0 ? (
          <Text variant="micro" className="block text-foreground/30">{t("deviceTimeline.end")}</Text>
        ) : null}
      </div>
    </div>
  );
}

// ── Single row renderer ─────────────────────────────────────────────────

// Resolve the signed URL for a storage_path lazily — backend only
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

function readPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A non-health device timeline row (ambient / device context event). Since the
 * L0 unification the row is the `pai_raw` payload flattened to the top level
 * (kind / salience / confidence + the source payload like storage_path) plus
 * id / occurred_at / device_id / reference_count. The endpoint does NOT fold in
 * the raw `title` / `snippet` columns, so there's no summary text — we render
 * the kind (falling back to the entity_type) + media + occurred_at.
 */
function ContextRow({ row, entityType }: { row: DeviceContextRow; entityType: string }) {
  const { t } = useTranslation("connect");
  const label = (typeof row.kind === "string" && row.kind) || entityType;
  const filePath = useMemo(() => {
    // backend writes storage_path; legacy plugin wrote file_path. The timeline
    // flattens payload to the row top level, so read both from there.
    return readPayloadString(row.storage_path) ?? readPayloadString(row.file_path);
  }, [row.storage_path, row.file_path]);

  const mediaUrl = useDeviceMediaUrl(filePath);
  const mediaKind = useMemo(() => classifyMediaKind(label, filePath), [label, filePath]);
  const occurred = useMemo(() => formatTime(row.occurred_at), [row.occurred_at]);

  return (
    <li className="glass-card p-3 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <Text variant="micro" className="text-foreground/40 tabular-nums shrink-0">{occurred}</Text>
        <Text variant="micro" className="text-foreground/60 px-1.5 py-0.5 rounded bg-foreground/5 shrink-0">
          {label}
        </Text>
      </div>

      {mediaKind === "image" && mediaUrl && (
        <img
          src={mediaUrl}
          alt={label}
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
          className="text-caption text-primary underline break-all"
        >
          {t("deviceTimeline.download", { name: filePath?.split("/").pop() ?? "" })}
        </a>
      )}
    </li>
  );
}

function HealthRow({ obs }: { obs: DeviceHealthObservation }) {
  const occurred = useMemo(() => formatTime(obs.occurred_at), [obs.occurred_at]);
  const metric = obs.metric ?? obs.observation_type;
  const valueLabel =
    obs.value === null
      ? "—"
      : Number.isInteger(obs.value)
        ? String(obs.value)
        : obs.value.toFixed(2);
  return (
    <li className="glass-card p-3 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <Text variant="micro" className="text-foreground/40 tabular-nums shrink-0">{occurred}</Text>
        <span className="text-micro text-foreground/60 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 shrink-0 flex items-center gap-1">
          <Activity size={10} strokeWidth={1.75} /> health.{metric}
        </span>
        <span className="text-xs font-medium tabular-nums">
          {valueLabel}
          {obs.unit ? <span className="text-foreground/40"> {obs.unit}</span> : null}
        </span>
      </div>
      <div className="text-micro text-foreground/40 leading-snug flex flex-wrap gap-x-3">
        <span>{obs.observation_type}</span>
        {obs.source_app ? <span>{obs.source_app}</span> : null}
        {obs.local_date ? <span>{obs.local_date}</span> : null}
      </div>
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
