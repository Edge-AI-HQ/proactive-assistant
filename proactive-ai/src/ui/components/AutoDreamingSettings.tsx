import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiPost } from "@/lib/api";

interface AutoDreamingSchedule {
  type: "daily";
  hour: number;
  minute: number;
  timezone: string;
}

interface AutoDreamingRun {
  id: string;
  trigger?: string;
  status: string;
  startedAt?: string;
  completedAt?: string | null;
  appliedAt?: string | null;
  superseded?: boolean;
  summaryJson?: { text?: string } | null;
  sourceStatsJson?: Record<string, { status?: string; count?: number; message?: string }> | null;
}

interface DreamSourceBreakdown {
  sourceId: string;
  status: "ok" | "skipped" | "error";
  itemCount: number;
  reason?: string;
  connectors?: Array<{
    connectorId: string;
    status: "ok" | "skipped" | "error";
    itemCount: number;
    reason?: string;
  }>;
}

interface DreamRunDetailResponse {
  ok: boolean;
  run: AutoDreamingRun;
  detail: {
    rawInputs: Record<string, unknown>;
    normalizedInputs: Record<string, unknown>;
    summary: { kind: string; text: string };
    dreamMarkdownPath: string | null;
    dreamMarkdown: string;
    profileDelta: Record<string, unknown>;
    candidates: Array<Record<string, unknown>>;
    sourceBreakdown: DreamSourceBreakdown[];
    logPath: string | null;
    logText: string;
  };
}

type ViewMode = "home" | "history" | "detail";

function scheduleLabel(schedule: AutoDreamingSchedule | null): string {
  if (!schedule) return "Runs every day at 6:00 AM";
  const suffix = schedule.hour >= 12 ? "PM" : "AM";
  const hour = schedule.hour % 12 || 12;
  const minute = String(schedule.minute).padStart(2, "0");
  return `Runs every day at ${hour}:${minute} ${suffix}`;
}

function formatStatusLabel(status: string): string {
  if (!status) return "unknown";
  return status.replace(/_/g, " ");
}

function statusTone(status: string): string {
  if (status === "ok" || status === "completed") return "text-emerald-600 bg-emerald-500/10";
  if (status === "error" || status === "failed") return "text-red-600 bg-red-500/10";
  return "text-amber-700 bg-amber-500/10";
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDreamRunTitle(run: AutoDreamingRun): string {
  if (!run.startedAt) return run.id;
  const date = new Date(run.startedAt);
  if (Number.isNaN(date.getTime())) return run.id;
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${day} · ${run.trigger ?? "manual"}`;
}

export default function AutoDreamingSettings() {
  const [enabled, setEnabled] = useState(false);
  const [schedule, setSchedule] = useState<AutoDreamingSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<ViewMode>("home");
  const [runs, setRuns] = useState<AutoDreamingRun[]>([]);
  const [detail, setDetail] = useState<DreamRunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadSettings() {
      try {
        const res = await apiFetch("/api/settings/auto-dreaming");
        const data = await res.json() as {
          ok: boolean;
          enabled: boolean;
          schedule: AutoDreamingSchedule;
        };
        if (!mounted) return;
        setEnabled(Boolean(data.enabled));
        setSchedule(data.schedule);
        const runsRes = await apiFetch("/api/dreaming/runs");
        const runsData = await runsRes.json() as { ok: boolean; runs: AutoDreamingRun[] };
        if (!mounted) return;
        setRuns(runsData.runs ?? []);
      } catch {
        if (!mounted) return;
        setError("Failed to load auto dreaming");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (view !== "detail" || detail?.run.status !== "running") return;
    const timer = window.setTimeout(() => {
      void loadDetail(detail.run.id, { background: true });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [detail?.run.id, detail?.run.status, view]);

  const latestRun = useMemo(() => runs[0] ?? null, [runs]);

  const handleToggle = async () => {
    const previous = enabled;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost("/api/settings/auto-dreaming", { enabled: next });
      const data = await res.json() as {
        ok: boolean;
        enabled: boolean;
        schedule: AutoDreamingSchedule;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setEnabled(previous);
        setError(data.error ?? "Failed to save auto dreaming");
        return;
      }
      setEnabled(Boolean(data.enabled));
      setSchedule(data.schedule);
      setNotice(next ? "Auto Dreaming enabled." : "Auto Dreaming disabled.");
    } catch {
      setEnabled(previous);
      setError("Failed to save auto dreaming");
    } finally {
      setSaving(false);
    }
  };

  const loadHistory = async (background = false) => {
    if (!background) {
      setError(null);
      setNotice(null);
    }
    const res = await apiFetch("/api/dreaming/runs");
    const data = await res.json() as { ok: boolean; runs: AutoDreamingRun[] };
    setRuns(data.runs ?? []);
    if (!background) setView("history");
  };

  const loadDetail = async (runId: string, options?: { background?: boolean }) => {
    if (!options?.background) {
      setError(null);
      setNotice(null);
      setDetailLoading(true);
    }
    try {
      const res = await apiFetch(`/api/dreaming/runs/${runId}`);
      const data = await res.json() as DreamRunDetailResponse;
      setDetail(data);
      if (!options?.background) setView("detail");
    } catch {
      if (!options?.background) setError("Failed to load dream run detail");
    } finally {
      if (!options?.background) setDetailLoading(false);
    }
  };

  const handleRunDreaming = async () => {
    setStartingRun(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost("/api/dreaming/run", {});
      const data = await res.json() as { ok: boolean; runId: string; status: string; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to start dreaming");
        return;
      }
      setNotice(`Dreaming started: ${data.runId}`);
      await loadHistory(true);
      await loadDetail(data.runId);
    } catch {
      setError("Failed to start dreaming");
    } finally {
      setStartingRun(false);
    }
  };

  const handleApply = async () => {
    if (!detail) return;
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost(`/api/dreaming/runs/${detail.run.id}/apply-profile`, {});
      const data = await res.json() as { ok: boolean; run: AutoDreamingRun; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to apply profile changes");
        return;
      }
      setDetail((current) => current ? { ...current, run: data.run } : current);
      setNotice("Profile changes applied.");
      await loadHistory(true);
    } catch {
      setError("Failed to apply profile changes");
    }
  };

  if (view === "history") {
    return (
      <div className="rounded-3xl bg-white/42 px-4 py-4 backdrop-blur-2xl border border-white/45 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Dreaming History</h2>
          <button type="button" onClick={() => setView("home")} className="text-xs text-foreground/60">
            Back
          </button>
        </div>
        <div className="space-y-2">
          {runs.map((run) => {
            const activeSourceCount = Object.values(run.sourceStatsJson ?? {}).filter((item) => Number(item?.count ?? 0) > 0).length;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => void loadDetail(run.id)}
                className="w-full rounded-2xl bg-foreground/[0.04] px-3 py-3 text-left space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-foreground">{formatDreamRunTitle(run)}</div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(run.status)}`}>
                    {formatStatusLabel(run.status)}
                  </span>
                </div>
                <div className="text-[10px] text-foreground/35">{run.id}</div>
                <div className="text-[11px] text-foreground/55">
                  {run.summaryJson?.text ?? "No summary yet"}
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-foreground/45">
                  <span>{run.trigger ?? "manual"}</span>
                  <span>{formatTimestamp(run.startedAt)}</span>
                  <span>{activeSourceCount} active source(s)</span>
                  <span>{run.appliedAt ? "Applied" : run.superseded ? "Superseded" : "Not applied"}</span>
                </div>
              </button>
            );
          })}
          {runs.length === 0 && (
            <p className="text-[11px] text-foreground/45">No dreaming runs yet.</p>
          )}
        </div>
      </div>
    );
  }

  if (view === "detail" && detail) {
    return (
      <div className="rounded-3xl bg-white/42 px-4 py-4 backdrop-blur-2xl border border-white/45 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Dream Run Detail</h2>
            <p className="text-[11px] text-foreground/45 mt-1">{formatDreamRunTitle(detail.run)}</p>
            <p className="text-[10px] text-foreground/30 mt-1">{detail.run.id}</p>
          </div>
          <button type="button" onClick={() => setView("history")} className="text-xs text-foreground/60">
            Back
          </button>
        </div>

        <div className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">Run Status</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(detail.run.status)}`}>
              {formatStatusLabel(detail.run.status)}
            </span>
          </div>
          <p className="text-xs text-foreground/70">{detail.detail.summary.text}</p>
          <div className="flex flex-wrap gap-2 text-[10px] text-foreground/45">
            <span>Started {formatTimestamp(detail.run.startedAt)}</span>
            <span>Completed {formatTimestamp(detail.run.completedAt)}</span>
            <span>{detail.run.appliedAt ? "Profile applied" : "Profile pending apply"}</span>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Dream Journal</h3>
          <div className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-2">
            {detail.detail.dreamMarkdownPath && (
              <p className="text-[10px] text-foreground/45 break-all">{detail.detail.dreamMarkdownPath}</p>
            )}
            <pre className="whitespace-pre-wrap text-[11px] leading-5 text-foreground/75">
              {detail.detail.dreamMarkdown || "No dream journal yet."}
            </pre>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Source Status</h3>
          <div className="space-y-2">
            {detail.detail.sourceBreakdown.map((source) => (
              <div key={source.sourceId} className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-foreground">{source.sourceId}</div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(source.status)}`}>
                    {formatStatusLabel(source.status)} · {source.itemCount}
                  </span>
                </div>
                {source.reason && (
                  <p className="text-[11px] text-foreground/55">{source.reason}</p>
                )}
                {source.connectors && source.connectors.length > 0 && (
                  <div className="space-y-1">
                    {source.connectors.map((connector) => (
                      <div key={`${source.sourceId}-${connector.connectorId}`} className="flex items-start justify-between gap-3 text-[11px]">
                        <div>
                          <div className="font-medium text-foreground/80">{connector.connectorId}</div>
                          {connector.reason && (
                            <div className="text-foreground/45">{connector.reason}</div>
                          )}
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(connector.status)}`}>
                          {formatStatusLabel(connector.status)} · {connector.itemCount}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {detail.detail.sourceBreakdown.length === 0 && (
              <p className="text-[11px] text-foreground/45">No source results recorded yet.</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Candidate Cards</h3>
          {detail.detail.candidates.length > 0 ? (
            detail.detail.candidates.map((candidate) => (
              <div key={String(candidate.id)} className="rounded-2xl bg-foreground/[0.04] px-3 py-2">
                <div className="text-xs font-medium text-foreground">{String(candidate.title ?? candidate.id)}</div>
                <div className="text-[11px] text-foreground/45 mt-1">{String(candidate.reason ?? "")}</div>
              </div>
            ))
          ) : (
            <p className="text-[11px] text-foreground/45">No candidate cards for this run.</p>
          )}
        </div>

        <details className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Dreaming Logs</summary>
          <div className="mt-2 space-y-2">
            {detail.detail.logPath && (
              <p className="text-[10px] text-foreground/45 break-all">{detail.detail.logPath}</p>
            )}
            <pre className="max-h-48 overflow-auto rounded-2xl bg-black/[0.04] p-3 text-[10px] text-foreground/70 whitespace-pre-wrap">
              {detail.detail.logText || "No run logs yet."}
            </pre>
          </div>
        </details>

        <details className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Profile Diff</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-2xl bg-black/[0.04] p-3 text-[10px] text-foreground/70">
            {JSON.stringify(detail.detail.profileDelta, null, 2)}
          </pre>
        </details>

        <details className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Raw Inputs</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-2xl bg-black/[0.04] p-3 text-[10px] text-foreground/70">
            {JSON.stringify(detail.detail.rawInputs, null, 2)}
          </pre>
        </details>

        <button
          type="button"
          onClick={() => void handleApply()}
          disabled={Boolean(detail.run.appliedAt) || detail.run.status !== "completed" || detail.run.superseded}
          className="w-full rounded-2xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {detail.run.appliedAt ? "Applied" : detail.run.superseded ? "Superseded" : detail.run.status === "running" ? "Waiting For Completion" : "Apply Profile Changes"}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-3xl bg-white/42 px-4 py-4 backdrop-blur-2xl border border-white/45 space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Auto Dreaming</h2>
          <p className="text-[11px] text-foreground/42 mt-1.5">
            {scheduleLabel(schedule)}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Auto dreaming"
          disabled={loading || saving}
          onClick={() => void handleToggle()}
          className={`
            relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full
            border border-white/45 transition-colors duration-200 ease-in-out
            disabled:cursor-not-allowed disabled:opacity-40
            ${enabled ? "bg-primary" : "bg-foreground/10"}
          `}
        >
          <span
            className={`
              pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out
              ${enabled ? "translate-x-[22px]" : "translate-x-[3px]"}
            `}
          />
        </button>
      </div>

      {latestRun && (
        <div className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">Latest Dream Run</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(latestRun.status)}`}>
              {formatStatusLabel(latestRun.status)}
            </span>
          </div>
          <p className="text-[11px] text-foreground/60">{latestRun.summaryJson?.text ?? "No summary yet."}</p>
          <p className="text-[10px] text-foreground/40">{formatTimestamp(latestRun.startedAt)}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleRunDreaming()}
          disabled={startingRun || detailLoading}
          className="flex-1 rounded-2xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {startingRun ? "Starting..." : "Run Dreaming"}
        </button>
        <button
          type="button"
          onClick={() => void loadHistory()}
          className="flex-1 rounded-2xl bg-foreground/[0.06] px-3 py-2 text-xs font-medium text-foreground"
        >
          View History
        </button>
      </div>

      {notice && (
        <p className="text-[11px] text-emerald-600/90">{notice}</p>
      )}
      {error && (
        <p className="text-[11px] text-red-500/80">{error}</p>
      )}
    </div>
  );
}
