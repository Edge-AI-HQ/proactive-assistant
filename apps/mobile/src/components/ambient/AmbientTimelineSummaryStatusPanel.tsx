/**
 * AmbientTimelineSummaryStatusPanel — web 同名组件的 RN 对应物（settings →
 * Ambient 子页第③块）。显示本地 LLM 时间线摘要管线状态：pending/summarizing/
 * ready/failed 窗口计数 + LLM 卡数 + store 就绪 + Trigger 立即生成。
 * 读 core 的 durable timeline store（getAmbientTimelineStore），Trigger 调
 * refreshTimeline（pipeline → 模型桥 → ④ 的端侧 LLM）。5 秒自刷。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { AlertCircle, CheckCircle2, Clock, Play, RefreshCcw, Sparkles } from "lucide-react-native";
import { todayLocalDate, type AmbientCandidateWindow, type AmbientTimelineEvent, type TimelineStoreStatus } from "@pin-ai/core";

import { GlassCard } from "../../ui/GlassCard";
import { usePageActive } from "../app/KeepAlivePage";
import { getAmbientTimelineStore, refreshTimeline } from "../../ambient/timeline";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const TONES = {
  ok: { fg: "#047857", bg: "rgba(16, 185, 129, 0.1)" },
  warn: { fg: "#b45309", bg: "rgba(245, 158, 11, 0.1)" },
  error: { fg: "#b91c1c", bg: "rgba(239, 68, 68, 0.1)" },
  muted: { fg: fg(0.55), bg: fg(0.04) },
} as const;
type Tone = keyof typeof TONES;
type SummaryPanelStatus = "error" | "summarizing" | "ready" | "waiting" | "idle";

interface SummaryStatusSnapshot {
  storeStatus: TimelineStoreStatus | null;
  pending: AmbientCandidateWindow[];
  summarized: AmbientCandidateWindow[];
  skipped: AmbientCandidateWindow[];
  failed: AmbientCandidateWindow[];
  processing: AmbientCandidateWindow[];
  llmEvents: AmbientTimelineEvent[];
  error: string | null;
}

const EMPTY_SNAPSHOT: SummaryStatusSnapshot = {
  storeStatus: null,
  pending: [],
  summarized: [],
  skipped: [],
  failed: [],
  processing: [],
  llmEvents: [],
  error: null,
};

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function statusTone(status: SummaryPanelStatus): Tone {
  if (status === "ready") return "ok";
  if (status === "summarizing" || status === "waiting") return "warn";
  if (status === "error") return "error";
  return "muted";
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  const t = TONES[tone];
  return (
    <View
      className="flex-1"
      style={{ borderRadius: 12, borderWidth: 1, borderColor: fg(0.1), backgroundColor: "rgba(255,255,255,0.4)", padding: 12 }}
    >
      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 13, letterSpacing: 1.2, color: fg(0.4) }}>
        {label.toUpperCase()}
      </Text>
      <View style={{ alignSelf: "flex-start", marginTop: 4, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: t.bg }}>
        <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: t.fg }}>{value}</Text>
      </View>
    </View>
  );
}

function StatusRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
      <View className="flex-row items-center" style={{ gap: 6 }}>
        {icon}
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55) }}>{label}</Text>
      </View>
      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, lineHeight: 15, color: fg(0.7) }}>{value}</Text>
    </View>
  );
}

export default function AmbientTimelineSummaryStatusPanel() {
  const { t } = useTranslation("ambient");
  const pageActive = usePageActive();
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const [snapshot, setSnapshot] = useState<SummaryStatusSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [summaryRunning, setSummaryRunning] = useState(false);
  const runningRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      await store.init();
      const localDate = todayLocalDate();
      const [windows, llmEvents] = await Promise.all([
        store.listCandidateWindows({ localDate, windowType: "transcript_session", limit: 100 }),
        store.listTimelineEventsByGenerationSource(localDate, "llm_summary", { visibleOnly: true, limit: 20 }),
      ]);
      setSnapshot({
        storeStatus: store.status(),
        pending: windows.filter((w) => (w.summaryStatus ?? "pending") === "pending"),
        summarized: windows.filter((w) => (w.summaryStatus ?? "pending") === "summarized"),
        skipped: windows.filter((w) => (w.summaryStatus ?? "pending") === "skipped_low_value"),
        failed: windows.filter((w) => {
          const s = w.summaryStatus ?? "pending";
          return s === "failed_retryable" || s === "failed_terminal" || Boolean(w.lastErrorCode);
        }),
        processing: windows.filter((w) => (w.summaryStatus ?? "pending") === "processing"),
        llmEvents,
        error: null,
      });
      setLastRefreshAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (err) {
      setSnapshot((prev) => ({ ...prev, storeStatus: store.status(), error: describeError(err) }));
    } finally {
      setLoading(false);
    }
  }, [store]);

  const runSummaryNow = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setSummaryRunning(true);
    setSnapshot((prev) => ({ ...prev, error: null }));
    try {
      await refreshTimeline(todayLocalDate(), { force: true });
      await refresh();
    } catch (err) {
      setSnapshot((prev) => ({ ...prev, storeStatus: store.status(), error: describeError(err) }));
    } finally {
      runningRef.current = false;
      setSummaryRunning(false);
    }
  }, [refresh, store]);

  useEffect(() => {
    // 页面隐藏时暂停轮询（keep-alive 常驻后 Setting 切走仍挂载）；切回立即刷一次。
    if (!pageActive) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh, pageActive]);

  const latestEvent = snapshot.llmEvents[snapshot.llmEvents.length - 1] ?? null;
  const latestFailure =
    [...snapshot.failed].sort(
      (a, b) => Date.parse(b.lastAttemptAt ?? b.updatedAt) - Date.parse(a.lastAttemptAt ?? a.updatedAt),
    )[0] ?? null;
  const status: SummaryPanelStatus = snapshot.error
    ? "error"
    : snapshot.processing.length > 0
      ? "summarizing"
      : snapshot.llmEvents.length > 0
        ? "ready"
        : snapshot.pending.length > 0
          ? "waiting"
          : "idle";

  return (
    <GlassCard strong className="mt-3 p-4">
      {/* 标题 + 按钮同一行(标题左 / 按钮右);描述移到下方独占满宽,不再被按钮挤到半宽换行。
          按钮圆角 = dev rounded-lg = var(--radius) = 20px(不是 Tailwind 默认 8——刷新钮 29px
          见方配 20 圆角被裁成正圆、Trigger 成胶囊,即 dev 的「圆」形)。 */}
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <Sparkles size={15} strokeWidth={1.8} color={fg(0.55)} />
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 16, lineHeight: 20, color: fg() }}>
            {t("summaryStatus.title")}
          </Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 6 }}>
          <Pressable onPress={() => void runSummaryNow()} disabled={summaryRunning} accessibilityRole="button" accessibilityLabel={t("summaryStatus.runNowAria")}>
            <View
              className="flex-row items-center"
              style={{ gap: 6, borderRadius: 20, borderWidth: 1, borderColor: fg(0.1), backgroundColor: fg(), paddingHorizontal: 10, paddingVertical: 8, opacity: summaryRunning ? 0.45 : 1 }}
            >
              <Play size={12} strokeWidth={2} color="hsl(220, 30%, 96%)" />
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: "hsl(220, 30%, 96%)" }}>
                {summaryRunning ? t("summaryStatus.running") : t("summaryStatus.trigger")}
              </Text>
            </View>
          </Pressable>
          <Pressable onPress={() => void refresh()} accessibilityRole="button" accessibilityLabel={t("summaryStatus.refreshAria")} hitSlop={4}>
            <View style={{ borderRadius: 20, borderWidth: 1, borderColor: fg(0.1), backgroundColor: fg(0.03), padding: 8 }}>
              <RefreshCcw size={13} strokeWidth={1.8} color={fg(0.55)} />
            </View>
          </Pressable>
        </View>
      </View>
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 17, color: fg(0.55), marginTop: 4 }}>
        {t("summaryStatus.description")}
      </Text>

      {/* 2×2 指标 */}
      <View style={{ gap: 8, marginTop: 12 }}>
        <View className="flex-row" style={{ gap: 8 }}>
          <Metric label={t("summaryStatus.metricStatus")} value={loading ? t("summaryStatus.loading") : t(`summaryStatus.status.${status}`)} tone={statusTone(status)} />
          <Metric label={t("summaryStatus.metricLlmCards")} value={String(snapshot.llmEvents.length)} tone="ok" />
        </View>
        <View className="flex-row" style={{ gap: 8 }}>
          <Metric label={t("summaryStatus.metricPending")} value={String(snapshot.pending.length)} tone={snapshot.pending.length > 0 ? "warn" : "muted"} />
          <Metric label={t("summaryStatus.metricFailed")} value={String(snapshot.failed.length)} tone={snapshot.failed.length > 0 ? "error" : "muted"} />
        </View>
      </View>

      {/* 状态明细盒 */}
      <View style={{ marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: fg(0.1), backgroundColor: fg(0.03), padding: 12, gap: 8 }}>
        <StatusRow icon={<CheckCircle2 size={13} strokeWidth={1.8} color={fg(0.55)} />} label={t("summaryStatus.summarizedWindows")} value={snapshot.summarized.length} />
        <StatusRow icon={<Clock size={13} strokeWidth={1.8} color={fg(0.55)} />} label={t("summaryStatus.skippedWindows")} value={snapshot.skipped.length} />
        <StatusRow icon={<Clock size={13} strokeWidth={1.8} color={fg(0.55)} />} label={t("summaryStatus.processingWindows")} value={snapshot.processing.length} />
        {latestEvent ? (
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: fg(0.55) }}>
            {t("summaryStatus.latestCard")} <Text style={{ fontFamily: "Inter_500Medium", color: fg(0.75) }}>{latestEvent.title}</Text>
          </Text>
        ) : null}
        {latestFailure?.lastErrorCode ? (
          <View style={{ gap: 2 }}>
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <AlertCircle size={12} strokeWidth={1.8} color={TONES.warn.fg} />
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: TONES.warn.fg }}>
                {t("summaryStatus.lastError", { code: latestFailure.lastErrorCode })}
              </Text>
            </View>
            {latestFailure.summaryErrorMessage ? (
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: TONES.warn.fg, paddingLeft: 18 }}>
                {t("summaryStatus.detail", { message: latestFailure.summaryErrorMessage })}
              </Text>
            ) : null}
          </View>
        ) : null}
        {snapshot.error ? (
          <View className="flex-row items-center" style={{ gap: 6 }}>
            <AlertCircle size={12} strokeWidth={1.8} color={TONES.error.fg} />
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: TONES.error.fg, flex: 1 }}>{snapshot.error}</Text>
          </View>
        ) : null}
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4) }}>
          {t("summaryStatus.storeLine", {
            mode: snapshot.storeStatus?.mode ?? t("summaryStatus.storeUnknown"),
            readiness: snapshot.storeStatus?.ready
              ? t("summaryStatus.storeReady")
              : t("summaryStatus.storeNotReady"),
          })}
          {lastRefreshAt ? t("summaryStatus.refreshedAt", { time: lastRefreshAt }) : ""}
        </Text>
      </View>
    </GlassCard>
  );
}
