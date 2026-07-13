/**
 * 单设备时间瀑布——web `ui-web/connect/DeviceTimeline.tsx` 的 RN 介质版。
 * 数据/过滤逻辑逐字对齐 web：统一 `/devices/{id}/timeline`（signals ∪ health，
 * keyset 分页），日期过滤 client-side；域函数复用 @pin-ai/core
 * （DEVICE_TIMELINE_QUICK_FILTERS / getDeviceTimelineDateRange / formatLocalDateInput）。
 *
 * 介质映射：
 * - `<input type="date">`（dev = WKWebView 自动渲染系统日期控件）→
 *   `@react-native-community/datetimepicker`（display="compact" 的系统 UIDatePicker）。
 * - 媒体：image → Image；video → expo-video VideoView（系统控制条）；audio →
 *   expo-audio 紧凑播放行（dev 是 `<audio controls>` 系统播放条，RN 无同款
 *   WebView 控件，用 expo-audio 自绘 play/pause+进度，同 VoiceIdentitySettings 族）；
 *   file → 打开签名 URL（expo-web-browser）。
 * - web 媒体 max-h-80(320) 自适高 → RN 固定 320 容器 + contain（RN 无自然尺寸流式布局）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as WebBrowser from "expo-web-browser";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Activity, ArrowLeft, Pause, Play } from "lucide-react-native";
import {
  DEVICE_TIMELINE_QUICK_FILTERS,
  deviceMediaUrl,
  fetchDeviceTimeline,
  formatLocalDateInput,
  getDeviceTimelineDateRange,
  type DeviceHealthObservation,
  type DeviceTimelineDayFilter,
  type DeviceTimelineItem,
  type DeviceContextRow,
  type UserDevice,
} from "@pin-ai/core";

import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;
const PAGE_SIZE = 10;

interface DeviceTimelineProps {
  device: UserDevice;
  onBack: () => void;
}

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
        const { items: batch, next_cursor, has_more } = await fetchDeviceTimeline(device.device_id, {
          before,
          limit: PAGE_SIZE,
        });
        if (requestSeq !== requestSeqRef.current) return;
        // client-side 日期过滤（服务端恒 newest-first，chip 秒切不回源）。
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

  // device / 日期过滤变化 → 重置重拉。
  useEffect(() => {
    requestSeqRef.current += 1;
    loadingRef.current = false;
    cursorRef.current = null;
    setItems([]);
    setHasMore(true);
    void loadPage(true);
  }, [loadPage]);

  // customDay(YYYY-MM-DD 本地日) → Date（给系统日期控件）。
  const customDayDate = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customDay);
    if (!m) return new Date();
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }, [customDay]);

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.headerRow}>
        <Pressable onPress={onBack} accessibilityRole="button">
          <View style={styles.backBtn}>
            <ArrowLeft size={14} color={fg(0.6)} />
            <Text style={styles.backText}>{t("deviceTimeline.back")}</Text>
          </View>
        </Pressable>
        <View style={styles.flex1MinW0}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {device.display_name ?? device.device_id}
          </Text>
          <Text style={styles.deviceMeta} numberOfLines={1}>
            {device.platform}
            {device.model ? ` · ${device.model}` : ""}
            {items.length > 0
              ? ` · ${t("deviceTimeline.loaded", { count: `${items.length}${hasMore ? "+" : ""}` })}`
              : ""}
          </Text>
        </View>
      </View>

      <View style={{ gap: 8 }}>
        {/* 快滤 chips（All / Today） */}
        <View style={styles.filterGrid}>
          {DEVICE_TIMELINE_QUICK_FILTERS.map((option) => {
            const active = dayFilter === option.value;
            return (
              <View key={option.value} style={styles.flex1}>
                <Pressable
                  onPress={() => setDayFilter(option.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.filterChip, active && styles.filterChipActive]}>
                    <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                      {t(`deviceTimeline.filters.${option.value}`)}
                    </Text>
                  </View>
                </Pressable>
              </View>
            );
          })}
        </View>
        {/* 自定日期行：系统日期控件 + 范围/数量 */}
        <View style={styles.customDayRow}>
          <View style={styles.flex1}>
            <DateTimePicker
              value={customDayDate}
              mode="date"
              display="compact"
              themeVariant="light"
              accessibilityLabel={t("deviceTimeline.filterByDay")}
              onChange={(_event, date) => {
                if (!date) return;
                setCustomDay(formatLocalDateInput(date));
                setDayFilter("custom");
              }}
              style={styles.datePicker}
            />
          </View>
          <View style={styles.rangeCol}>
            <Text style={styles.rangeText}>{dateRange.label}</Text>
            <Text style={styles.rangeText}>{t("deviceTimeline.shownCount", { count: items.length })}</Text>
          </View>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {items.length === 0 && !loading && !error ? (
        <Text style={styles.emptyText}>{t("deviceTimeline.emptyTimeline")}</Text>
      ) : null}

      <View style={{ gap: 8 }}>
        {items.map((it) =>
          // type 是后端契约的 discriminator（"signal"→context row / 其余→health），
          // union 无 literal tag 供 TS 窄化——边界处显式断言。
          it.type === "signal" ? (
            <SignalRow key={`s-${it.row.id}`} signal={it.row as DeviceContextRow} />
          ) : (
            <HealthRow key={`h-${it.row.id}`} obs={it.row as DeviceHealthObservation} />
          ),
        )}
      </View>

      <View style={styles.footerRow}>
        {loading ? (
          <View style={styles.rowGap8}>
            <Spinner size={12} color={fg(0.5)} />
            <Text style={styles.loadingText}>{t("common:status.loading")}</Text>
          </View>
        ) : hasMore ? (
          <Pressable onPress={() => void loadPage(false)} accessibilityRole="button">
            <View style={styles.loadMoreBtn}>
              <Text style={styles.loadMoreText}>{t("deviceTimeline.loadMore", { count: PAGE_SIZE })}</Text>
            </View>
          </Pressable>
        ) : items.length > 0 ? (
          <Text style={styles.endText}>{t("deviceTimeline.end")}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ── 单行渲染 ─────────────────────────────────────────────────────────────

/** storage_path 懒解析签名 URL（TTL 有限，不在渲染时烘进行）。 */
function useDeviceMediaUrl(filePath: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!filePath) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void deviceMediaUrl(filePath).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  return url;
}

function TimelineVideo({ url }: { url: string }) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = false;
  });
  return <VideoView player={player} style={styles.media} nativeControls contentFit="contain" />;
}

/** 紧凑音频行——dev `<audio controls>` 的 RN 等价（expo-audio 自绘）。 */
function TimelineAudio({ url }: { url: string }) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const duration = status.duration ?? 0;
  const current = status.currentTime ?? 0;
  const playing = status.playing;
  const toggle = () => {
    if (playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (duration > 0 && current >= duration - 0.05)) player.seekTo(0);
    player.play();
  };
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };
  return (
    <View style={styles.audioRow}>
      <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={playing ? "Pause" : "Play"}>
        <View style={styles.audioBtn}>
          {playing ? (
            <Pause size={12} color="#fff" strokeWidth={2.2} />
          ) : (
            <Play size={12} color="#fff" strokeWidth={2.2} style={{ marginLeft: 1 }} />
          )}
        </View>
      </Pressable>
      <View style={styles.audioTrack}>
        <View
          style={[
            styles.audioFill,
            { width: `${duration > 0 ? Math.min(100, (current / duration) * 100) : 0}%` },
          ]}
        />
      </View>
      <Text style={styles.audioTime}>
        {fmt(current)} / {fmt(duration)}
      </Text>
    </View>
  );
}

function SignalRow({ signal }: { signal: DeviceContextRow }) {
  const { t } = useTranslation("connect");
  const filePath = useMemo(() => {
    // 后端写 payload.storage_path；legacy plugin 写 file_path。过渡期两个都读。
    const p = signal.payload as { storage_path?: unknown; file_path?: unknown };
    const sp = typeof p.storage_path === "string" && p.storage_path.length > 0 ? p.storage_path : null;
    const fp = typeof p.file_path === "string" && p.file_path.length > 0 ? p.file_path : null;
    return sp ?? fp;
  }, [signal.payload]);

  const mediaUrl = useDeviceMediaUrl(filePath);
  const mediaKind = useMemo(() => classifyMediaKind(signal.kind ?? "", filePath), [signal.kind, filePath]);
  const occurred = useMemo(() => formatTime(signal.occurred_at), [signal.occurred_at]);
  // title/summary 走 DeviceContextRow 的透传索引签名（unknown）——边界处字符串化。
  const title = typeof signal.title === "string" ? signal.title : "";
  const summary = typeof signal.summary === "string" ? signal.summary : null;

  return (
    <GlassCard style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <Text style={styles.itemTime}>{occurred}</Text>
        <View style={styles.kindBadge}>
          <Text style={styles.kindBadgeText}>{signal.kind}</Text>
        </View>
        <Text style={styles.itemTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>

      {summary ? <Text style={styles.itemSummary}>{summary}</Text> : null}

      {mediaKind === "image" && mediaUrl ? (
        <Image source={{ uri: mediaUrl }} style={styles.media} resizeMode="contain" />
      ) : null}

      {mediaKind === "video" && mediaUrl ? <TimelineVideo url={mediaUrl} /> : null}

      {mediaKind === "audio" && mediaUrl ? <TimelineAudio url={mediaUrl} /> : null}

      {mediaKind === "file" && mediaUrl ? (
        <Pressable onPress={() => void WebBrowser.openBrowserAsync(mediaUrl)} accessibilityRole="link">
          <Text style={styles.fileLink}>
            {t("deviceTimeline.download", { name: filePath?.split("/").pop() ?? "" })}
          </Text>
        </Pressable>
      ) : null}
    </GlassCard>
  );
}

function HealthRow({ obs }: { obs: DeviceHealthObservation }) {
  const occurred = useMemo(() => formatTime(obs.occurred_at), [obs.occurred_at]);
  const metric = obs.metric ?? obs.observation_type;
  const valueLabel =
    typeof obs.value !== "number" || !Number.isFinite(obs.value)
      ? "—"
      : Number.isInteger(obs.value)
        ? String(obs.value)
        : obs.value.toFixed(2);
  return (
    <GlassCard style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <Text style={styles.itemTime}>{occurred}</Text>
        <View style={styles.healthBadge}>
          <Activity size={10} strokeWidth={1.75} color="#047857" />
          <Text style={styles.healthBadgeText}>health.{metric}</Text>
        </View>
        <Text style={styles.healthValue}>
          {valueLabel}
          {obs.unit ? <Text style={{ color: fg(0.4) }}> {obs.unit}</Text> : null}
        </Text>
      </View>
      <View style={styles.healthMetaRow}>
        <Text style={styles.healthMeta}>{obs.observation_type}</Text>
        {obs.source_app ? <Text style={styles.healthMeta}>{obs.source_app}</Text> : null}
        {obs.local_date ? <Text style={styles.healthMeta}>{obs.local_date}</Text> : null}
      </View>
    </GlassCard>
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
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  flex1MinW0: { flex: 1, minWidth: 0 },
  rowGap8: { flexDirection: "row", alignItems: "center", gap: 8 },

  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.6) },
  deviceName: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  deviceMeta: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4) },

  filterGrid: { flexDirection: "row", gap: 6 },
  filterChip: {
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: fg(0.1),
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  filterChipActive: { borderColor: fg(0.8), backgroundColor: fg(0.85) },
  filterChipText: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.55) },
  filterChipTextActive: { color: "#f2f4f8" },

  customDayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.025),
    padding: 6,
  },
  datePicker: { alignSelf: "flex-start" },
  rangeCol: { minWidth: 72, flexShrink: 0, alignItems: "flex-end" },
  rangeText: { fontSize: 10, lineHeight: 13, fontFamily: "Inter_400Regular", color: fg(0.4), textAlign: "right" },

  errorBox: { borderRadius: 8, backgroundColor: "rgba(239,68,68,0.1)", paddingHorizontal: 8, paddingVertical: 6 },
  errorText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: "rgba(239,68,68,0.8)" },
  emptyText: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
    color: fg(0.4),
    textAlign: "center",
    paddingHorizontal: 8,
    paddingVertical: 32,
  },

  itemCard: { padding: 12, gap: 6 },
  itemHeader: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  itemTime: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4), fontVariant: ["tabular-nums"] },
  kindBadge: { borderRadius: 4, backgroundColor: fg(0.05), paddingHorizontal: 6, paddingVertical: 2 },
  kindBadgeText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.6) },
  itemTitle: { flex: 1, fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: "#1d2130" },
  itemSummary: { fontSize: 11, lineHeight: 18, fontFamily: "Inter_400Regular", color: fg(0.6) },
  media: { width: "100%", height: 320, borderRadius: 18, backgroundColor: fg(0.05) },
  fileLink: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: "Inter_400Regular",
    color: "#d757ea", // --primary hsl(292 78% 63%)
    textDecorationLine: "underline",
  },

  audioRow: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, backgroundColor: fg(0.05), paddingHorizontal: 12, paddingVertical: 8 },
  audioBtn: { width: 28, height: 28, borderRadius: 999, backgroundColor: "#1d2130", alignItems: "center", justifyContent: "center" },
  audioTrack: { flex: 1, height: 4, borderRadius: 999, backgroundColor: fg(0.1), overflow: "hidden" },
  audioFill: { height: "100%", borderRadius: 999, backgroundColor: fg(0.7) },
  audioTime: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.45), fontVariant: ["tabular-nums"] },

  healthBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 4,
    backgroundColor: "rgba(16,185,129,0.1)",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  healthBadgeText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: "#047857" },
  healthValue: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: "#1d2130", fontVariant: ["tabular-nums"] },
  healthMetaRow: { flexDirection: "row", flexWrap: "wrap", columnGap: 12 },
  healthMeta: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4) },

  footerRow: { alignItems: "center", paddingTop: 8 },
  loadingText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.5) },
  loadMoreBtn: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: fg(0.1),
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  loadMoreText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.6) },
  endText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.3) },
});
