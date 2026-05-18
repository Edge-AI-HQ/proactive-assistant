import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, Play, RefreshCcw, Sparkles } from "lucide-react";
import { isNative } from "@/lib/platform";
import {
  getAmbientTimelineStore,
  todayLocalDate,
  type AmbientCandidateWindow,
  type AmbientTimelineEvent,
  type TimelineStoreStatus,
} from "@/services/ambient/timeline";

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
            error: "Timeline summary generation is only available in the native app.",
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

  const latestEvent = snapshot.llmEvents.at(-1) ?? null;
  const latestFailure = [...snapshot.failed]
    .sort((a, b) => Date.parse(b.lastAttemptAt ?? b.updatedAt) - Date.parse(a.lastAttemptAt ?? a.updatedAt))[0] ?? null;
  const status = snapshot.error
    ? "Error"
    : snapshot.processing.length > 0
      ? "Summarizing"
      : snapshot.llmEvents.length > 0
        ? "Ready"
        : snapshot.pending.length > 0
          ? "Waiting"
          : "Idle";

  return (
    <div className="glass-card-strong p-4 space-y-3" data-testid="ambient-summary-status">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={15} strokeWidth={1.8} className="text-foreground/55" />
            <h2 className="text-base font-semibold text-foreground">Timeline summaries</h2>
          </div>
          <p className="text-[12px] text-foreground/55 leading-relaxed">
            Shows whether local LLM summary windows are pending, processing, or already written as Timeline cards.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void runSummaryNow()}
            disabled={summaryRunning}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground text-background px-2.5 py-2 text-[11px] font-semibold hover:opacity-90 disabled:opacity-45 disabled:cursor-not-allowed"
            aria-label="Run timeline summary now"
          >
            <Play size={12} strokeWidth={2} />
            {summaryRunning ? "Running" : "Summary now"}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-2 text-foreground/55 hover:bg-foreground/[0.06]"
            aria-label="Refresh timeline summary status"
          >
            <RefreshCcw size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Status" value={loading ? "Loading" : status} tone={statusTone(status)} />
        <Metric label="LLM cards" value={String(snapshot.llmEvents.length)} tone="ok" />
        <Metric label="Pending windows" value={String(snapshot.pending.length)} tone={snapshot.pending.length > 0 ? "warn" : "muted"} />
        <Metric label="Failed attempts" value={String(snapshot.failed.length)} tone={snapshot.failed.length > 0 ? "error" : "muted"} />
      </div>

      <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 space-y-2 text-[11px] text-foreground/55">
        <StatusRow icon={<CheckCircle2 size={13} />} label="Summarized windows" value={snapshot.summarized.length} />
        <StatusRow icon={<Clock size={13} />} label="Skipped low-value windows" value={snapshot.skipped.length} />
        <StatusRow icon={<Clock size={13} />} label="Processing windows" value={snapshot.processing.length} />
        {latestEvent && (
          <p className="leading-snug">
            Latest card: <span className="font-medium text-foreground/75">{latestEvent.title}</span>
          </p>
        )}
        {latestFailure?.lastErrorCode && (
          <div className="space-y-1 text-amber-700">
            <p className="flex items-center gap-1.5 leading-snug">
              <AlertCircle size={12} /> Last error: {latestFailure.lastErrorCode}
            </p>
            {latestFailure.summaryErrorMessage && (
              <p className="pl-[18px] leading-snug break-words">
                Detail: {latestFailure.summaryErrorMessage}
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
          Store: {snapshot.storeStatus?.mode ?? "unknown"} · {snapshot.storeStatus?.ready ? "ready" : "not ready"}
          {lastRefreshAt ? ` · refreshed ${lastRefreshAt}` : ""}
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
      <div className="text-[10px] uppercase tracking-[0.12em] text-foreground/40 font-semibold">{label}</div>
      <div className={`inline-flex mt-1 rounded-md px-2 py-0.5 text-[12px] font-semibold ${toneClass}`}>{value}</div>
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

function statusTone(status: string): "ok" | "warn" | "error" | "muted" {
  if (status === "Ready") return "ok";
  if (status === "Summarizing" || status === "Waiting") return "warn";
  if (status === "Error") return "error";
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
