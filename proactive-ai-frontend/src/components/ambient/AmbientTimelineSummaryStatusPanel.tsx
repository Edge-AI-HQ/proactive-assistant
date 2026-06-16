import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Clock, Play, RefreshCcw, Sparkles } from "lucide-react";
import { isNative } from "@/lib/platform";
import {
  getAmbientTimelineStore,
  todayLocalDate,
  type AmbientCandidateWindow,
  type AmbientTimelineEvent,
  type TimelineStoreStatus,
} from "@/services/ambient/timeline";
import { Text, i18n } from "@pin-ai/ui-web";

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

interface AmbientTimelineRuntime {
  refreshTimeline(localDate: string, options?: { force?: boolean }): Promise<void>;
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

export default function AmbientTimelineSummaryStatusPanel() {
  const { t } = useTranslation("ambient");
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const runtimeRef = useRef<AmbientTimelineRuntime | null>(null);
  const [snapshot, setSnapshot] = useState<SummaryStatusSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [summaryRunning, setSummaryRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      await store.init();
      const localDate = todayLocalDate();
      const [windows, llmEvents] = await Promise.all([
        store.listCandidateWindows({
          localDate,
          windowType: "transcript_session",
          limit: 100,
        }),
        store.listTimelineEventsByGenerationSource(localDate, "llm_summary", {
          visibleOnly: true,
          limit: 20,
        }),
      ]);
      setSnapshot({
        storeStatus: store.status(),
        pending: windows.filter((window) => (window.summaryStatus ?? "pending") === "pending"),
        summarized: windows.filter((window) => (window.summaryStatus ?? "pending") === "summarized"),
        skipped: windows.filter((window) => (window.summaryStatus ?? "pending") === "skipped_low_value"),
        failed: windows.filter((window) => {
          const status = window.summaryStatus ?? "pending";
          return status === "failed_retryable" || status === "failed_terminal" || Boolean(window.lastErrorCode);
        }),
        processing: windows.filter((window) => (window.summaryStatus ?? "pending") === "processing"),
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
    if (summaryRunning) return;
    setSummaryRunning(true);
    setSnapshot((prev) => ({ ...prev, error: null }));
    try {
      let runtime = runtimeRef.current;
      if (!runtime) {
        runtime = await loadNativeAmbientTimelineRuntime();
        if (!runtime) {
          setSnapshot((prev) => ({
            ...prev,
            storeStatus: store.status(),
            error: i18n.t("ambient:summaryStatus.nativeOnly"),
          }));
          return;
        }
        runtimeRef.current = runtime;
      }
      await runtime.refreshTimeline(todayLocalDate(), { force: true });
      await refresh();
    } catch (err) {
      setSnapshot((prev) => ({ ...prev, storeStatus: store.status(), error: describeError(err) }));
    } finally {
      setSummaryRunning(false);
    }
  }, [refresh, store, summaryRunning]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const latestEvent = snapshot.llmEvents[snapshot.llmEvents.length - 1] ?? null;
  const latestFailure = [...snapshot.failed]
    .sort((a, b) => Date.parse(b.lastAttemptAt ?? b.updatedAt) - Date.parse(a.lastAttemptAt ?? a.updatedAt))[0] ?? null;
  // Logical status enum — drives both the tone branch and the label key.
  // Only the label (t(`summaryStatus.status.${status}`)) is translated.
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
    <div className="glass-card-strong p-4 space-y-3" data-testid="ambient-summary-status">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={15} strokeWidth={1.8} className="text-foreground/55" />
            <h2 className="text-base font-semibold text-foreground">{t("summaryStatus.title")}</h2>
          </div>
          <Text variant="label" className="block text-foreground/55 leading-relaxed">
            {t("summaryStatus.description")}
          </Text>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void runSummaryNow()}
            disabled={summaryRunning}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground text-background px-2.5 py-2 text-caption font-semibold hover:opacity-90 disabled:opacity-45 disabled:cursor-not-allowed"
            aria-label={t("summaryStatus.runNowAria")}
          >
            <Play size={12} strokeWidth={2} />
            {summaryRunning ? t("summaryStatus.running") : t("summaryStatus.trigger")}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-2 text-foreground/55 hover:bg-foreground/[0.06]"
            aria-label={t("summaryStatus.refreshAria")}
          >
            <RefreshCcw size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label={t("summaryStatus.metricStatus")} value={loading ? t("summaryStatus.loading") : t(`summaryStatus.status.${status}`)} tone={statusTone(status)} />
        <Metric label={t("summaryStatus.metricLlmCards")} value={String(snapshot.llmEvents.length)} tone="ok" />
        <Metric label={t("summaryStatus.metricPending")} value={String(snapshot.pending.length)} tone={snapshot.pending.length > 0 ? "warn" : "muted"} />
        <Metric label={t("summaryStatus.metricFailed")} value={String(snapshot.failed.length)} tone={snapshot.failed.length > 0 ? "error" : "muted"} />
      </div>

      <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 space-y-2 text-caption text-foreground/55">
        <StatusRow icon={<CheckCircle2 size={13} />} label={t("summaryStatus.summarizedWindows")} value={snapshot.summarized.length} />
        <StatusRow icon={<Clock size={13} />} label={t("summaryStatus.skippedWindows")} value={snapshot.skipped.length} />
        <StatusRow icon={<Clock size={13} />} label={t("summaryStatus.processingWindows")} value={snapshot.processing.length} />
        {latestEvent && (
          <p className="leading-snug">
            {t("summaryStatus.latestCard")} <span className="font-medium text-foreground/75">{latestEvent.title}</span>
          </p>
        )}
        {latestFailure?.lastErrorCode && (
          <div className="space-y-1 text-amber-700">
            <p className="flex items-center gap-1.5 leading-snug">
              <AlertCircle size={12} /> {t("summaryStatus.lastError", { code: latestFailure.lastErrorCode })}
            </p>
            {latestFailure.summaryErrorMessage && (
              <p className="pl-[18px] leading-snug break-words">
                {t("summaryStatus.detail", { message: latestFailure.summaryErrorMessage })}
              </p>
            )}
          </div>
        )}
        {snapshot.error && (
          <p className="flex items-center gap-1.5 leading-snug text-red-700">
            <AlertCircle size={12} /> {snapshot.error}
          </p>
        )}
        <p className="text-foreground/40">
          {t("summaryStatus.storeLine", {
            mode: snapshot.storeStatus?.mode ?? t("summaryStatus.storeUnknown"),
            readiness: snapshot.storeStatus?.ready
              ? t("summaryStatus.storeReady")
              : t("summaryStatus.storeNotReady"),
          })}
          {lastRefreshAt ? t("summaryStatus.refreshedAt", { time: lastRefreshAt }) : ""}
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "error" | "muted" }) {
  const toneClass = {
    ok: "text-emerald-700 bg-emerald-500/10",
    warn: "text-amber-700 bg-amber-500/10",
    error: "text-red-700 bg-red-500/10",
    muted: "text-foreground/55 bg-foreground/[0.04]",
  }[tone];
  return (
    <div className="rounded-xl border border-foreground/10 bg-white/40 p-3">
      <Text variant="micro" weight="semibold" className="block uppercase tracking-[0.12em] text-foreground/40">{label}</Text>
      <div className={`inline-flex mt-1 rounded-md px-2 py-0.5 text-label font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function StatusRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5">{icon}{label}</span>
      <span className="font-semibold text-foreground/70">{value}</span>
    </div>
  );
}

type SummaryPanelStatus = "error" | "summarizing" | "ready" | "waiting" | "idle";

function statusTone(status: SummaryPanelStatus): "ok" | "warn" | "error" | "muted" {
  if (status === "ready") return "ok";
  if (status === "summarizing" || status === "waiting") return "warn";
  if (status === "error") return "error";
  return "muted";
}

async function loadNativeAmbientTimelineRuntime(): Promise<AmbientTimelineRuntime | null> {
  if (!isNative) return null;
  const { getAmbientRuntime } = await import("@/services/ambient");
  return getAmbientRuntime();
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
