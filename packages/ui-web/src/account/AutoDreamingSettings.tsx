import { useEffect, useMemo, useState } from "react";
import { useUserSettings } from "@pin-ai/state";
import { proxyFetch, proxyPost } from "@pin-ai/core";

// Auto-dreaming runs daily at 06:00 in the user's profile timezone. The
// cadence is fixed in the backend scheduler for now, so the UI only
// mirrors the user-facing label.
interface AutoDreamingSchedule {
  type: "daily";
  hour: number;
  minute: number;
  timezone: string;
}

const DREAMING_SCHEDULE: AutoDreamingSchedule = {
  type: "daily", hour: 6, minute: 0, timezone: "local",
};

// The backend returns snake_case keys (mirrors the dream_runs row shape).
// Pre-Phase-2a, only the Apply buttons read these fields and the buttons
// were always disabled before user clicked, so the camelCase mismatch
// silently rendered "Not applied" — harmless. Phase 2a turned the badges
// into the only signal, so the field names must actually match the API.
interface AutoDreamingRun {
  id: string;
  trigger?: string;
  status: string;
  started_at?: string;
  completed_at?: string | null;
  applied_at?: string | null;
  goals_applied_at?: string | null;
  superseded?: boolean;
  summary?: { text?: string } | null;
  source_stats?: Record<string, { status?: string; count?: number; message?: string }> | null;
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
    goalDelta: { changes?: Array<Record<string, unknown>> };
    candidates: Array<Record<string, unknown>>;
    sourceBreakdown: DreamSourceBreakdown[];
    logPath: string | null;
    logText: string;
  };
}

type ViewMode = "home" | "history" | "detail";
const DEFAULT_VISIBLE_ITEMS = 5;
const DEFAULT_VISIBLE_HISTORY_DAYS = 7;
const DEFAULT_VISIBLE_RUNS_PER_DAY = 3;

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
  if (!run.started_at) return run.id;
  const date = new Date(run.started_at);
  if (Number.isNaN(date.getTime())) return run.id;
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${day} · ${run.trigger ?? "manual"}`;
}

function runDayKey(run: AutoDreamingRun): string {
  if (!run.started_at) return "Unknown";
  const date = new Date(run.started_at);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function historyGroups(runs: AutoDreamingRun[]): Array<{ day: string; runs: AutoDreamingRun[] }> {
  const grouped = new Map<string, AutoDreamingRun[]>();
  for (const run of runs) {
    const day = runDayKey(run);
    const current = grouped.get(day) ?? [];
    current.push(run);
    grouped.set(day, current);
  }
  return Array.from(grouped.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([day, dayRuns]) => ({ day, runs: dayRuns }));
}

function todayDayKey(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function previousDayKey(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() - 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatItemMeta(item: Record<string, unknown>): string[] {
  const values = [item.timestamp, item.sender, item.calendar, item.start, item.location];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 4);
}

function itemSummaryText(item: Record<string, unknown>): string {
  for (const candidate of [item.preview, item.reason, item.context, item.body, item.description]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return "No summary available.";
}

function goalChangeTitle(change: Record<string, unknown>, index: number): string {
  const after = change.after && typeof change.after === "object" && !Array.isArray(change.after)
    ? change.after as Record<string, unknown>
    : null;
  const before = change.before && typeof change.before === "object" && !Array.isArray(change.before)
    ? change.before as Record<string, unknown>
    : null;
  return String(after?.title ?? before?.title ?? change.key ?? `Goal ${index + 1}`);
}

function normalizedSourceGroups(normalizedInputs: Record<string, unknown>): Array<{
  sourceId: string;
  items: Array<{ key: string; title: string; summary: string; meta: string[]; connector?: string }>;
}> {
  return Object.entries(normalizedInputs).flatMap(([sourceId, value]) => {
    if (!Array.isArray(value)) return [];
    const items = value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
      .map((item, index) => {
        const title =
          (typeof item.title === "string" && item.title.trim().length > 0 ? item.title : null)
          ?? (typeof item.subject === "string" && item.subject.trim().length > 0 ? item.subject : null)
          ?? `${sourceId} item ${index + 1}`;
        return {
          key: `${sourceId}-${typeof item.connector === "string" ? item.connector : "item"}-${index}`,
          title,
          summary: itemSummaryText(item),
          meta: formatItemMeta(item),
          connector: typeof item.connector === "string" ? item.connector : undefined,
        };
      });
    return [{ sourceId, items }];
  });
}

function rawConnectorGroups(rawInputs: Record<string, unknown>): Array<{
  sourceId: string;
  connectors: Array<{ connectorId: string; itemCount: number; raw: unknown }>;
}> {
  return Object.entries(rawInputs).flatMap(([sourceId, raw]) => {
    if (sourceId !== "personal" || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const connectors = (raw as { connectors?: Record<string, unknown> }).connectors;
    if (!connectors || typeof connectors !== "object") return [];
    return [{
      sourceId,
      connectors: Object.entries(connectors).map(([connectorId, connectorRaw]) => ({
        connectorId,
        itemCount: inferRawConnectorItemCount(connectorRaw),
        raw: connectorRaw,
      })),
    }];
  });
}

function inferRawConnectorItemCount(connectorRaw: unknown): number {
  if (!connectorRaw || typeof connectorRaw !== "object" || Array.isArray(connectorRaw)) return 0;
  const record = connectorRaw as Record<string, unknown>;
  if (typeof record.itemCount === "number" && Number.isFinite(record.itemCount)) return record.itemCount;

  const toolRuns = Array.isArray(record.toolRuns)
    ? record.toolRuns.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
  const toolRunCount = toolRuns.reduce((sum, toolRun) => {
    const itemCount = toolRun.itemCount;
    return sum + (typeof itemCount === "number" && Number.isFinite(itemCount) ? itemCount : 0);
  }, 0);
  if (toolRunCount > 0) return toolRunCount;

  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null;
  if (Array.isArray(record.messages)) return record.messages.length;
  if (Array.isArray(record.summary_view)) return record.summary_view.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (payload) {
    if (Array.isArray(payload.messages)) return payload.messages.length;
    if (Array.isArray(payload.summary_view)) return payload.summary_view.length;
    if (Array.isArray(payload.items)) return payload.items.length;
    if (Array.isArray(payload.event_data)) return payload.event_data.length;
    if (Array.isArray(payload.files)) return payload.files.length;
  }
  return 0;
}

export default function AutoDreamingSettings() {
  const { settings, loading: settingsLoading, saving, error: settingsError, patch } = useUserSettings();
  const [runsLoading, setRunsLoading] = useState(true);
  const [startingRun, setStartingRun] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<ViewMode>("home");
  const [runs, setRuns] = useState<AutoDreamingRun[]>([]);
  const [detail, setDetail] = useState<DreamRunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [visibleHistoryDays, setVisibleHistoryDays] = useState(DEFAULT_VISIBLE_HISTORY_DAYS);

  // Default ON, matching the pai_user_settings.auto_dreaming column DEFAULT
  // (migration 086). Server lazy-creates the row at TRUE; this is only the
  // pre-load display fallback.
  const enabled = settings?.autoDreaming ?? true;
  const schedule = DREAMING_SCHEDULE;
  const loading = settingsLoading || runsLoading;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const runsRes = await proxyFetch("/dreaming/runs");
        const runsData = await runsRes.json() as { ok: boolean; runs: AutoDreamingRun[] };
        if (!mounted) return;
        setRuns(runsData.runs ?? []);
      } catch {
        if (!mounted) return;
        setError("Failed to load dreaming runs");
      } finally {
        if (mounted) setRunsLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (settingsError) setError(settingsError);
  }, [settingsError]);

  useEffect(() => {
    if (view !== "detail" || detail?.run.status !== "running") return;
    const timer = window.setTimeout(() => {
      void loadDetail(detail.run.id, { background: true });
    }, 1500);
    return () => window.clearTimeout(timer);
    // 依赖刻意不挂 loadDetail（稳定引用），轮询只跟 run id/status/视图变化走
    // （本仓 lint 未启 react-hooks 规则，注释留意图）。
  }, [detail?.run.id, detail?.run.status, view]);

  const latestRun = useMemo(() => runs[0] ?? null, [runs]);
  const groupedRuns = useMemo(() => historyGroups(runs), [runs]);
  const normalizedGroups = useMemo(
    () => detail ? normalizedSourceGroups(detail.detail.normalizedInputs) : [],
    [detail],
  );
  const connectorGroups = useMemo(
    () => detail ? rawConnectorGroups(detail.detail.rawInputs) : [],
    [detail],
  );

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => ({ ...current, [key]: !current[key] }));
  };

  const isHistoryDayExpanded = (day: string): boolean => {
    const key = `history:${day}`;
    if (key in expandedGroups) return Boolean(expandedGroups[key]);
    const today = todayDayKey();
    return day === today || day === previousDayKey(today);
  };

  const isHistoryDayShowingAll = (day: string): boolean => Boolean(expandedGroups[`history-all:${day}`]);

  const handleToggle = async () => {
    const next = !enabled;
    setError(null);
    setNotice(null);
    const result = await patch({ autoDreaming: next });
    if (result) {
      setNotice(next ? "Auto Dreaming enabled." : "Auto Dreaming disabled.");
    } else {
      setError(settingsError ?? "Failed to save auto dreaming");
    }
  };

  const loadHistory = async (background = false) => {
    if (!background) {
      setError(null);
      setNotice(null);
    }
    try {
      const res = await proxyFetch("/dreaming/runs");
      const data = await res.json() as { ok: boolean; runs: AutoDreamingRun[] };
      setRuns(data.runs ?? []);
      if (!background) setVisibleHistoryDays(DEFAULT_VISIBLE_HISTORY_DAYS);
      if (!background) setView("history");
    } catch {
      if (!background) setError("Failed to load dreaming history");
    }
  };

  const loadDetail = async (runId: string, options?: { background?: boolean }) => {
    if (!options?.background) {
      setError(null);
      setNotice(null);
      setDetailLoading(true);
    }
    try {
      const res = await proxyFetch(`/dreaming/runs/${runId}`);
      // 404 = dispatcher hasn't materialized the run row yet (manual
      // trigger races scheduler tick). Don't blow away an existing
      // `detail` with the error body — the caller is polling, the
      // next tick will succeed.
      if (!res.ok) {
        if (!options?.background) {
          setError(res.status === 404 ? "Run not started yet — try again in a moment" : "Failed to load dream run detail");
        }
        return;
      }
      const data = await res.json() as DreamRunDetailResponse;
      setDetail(data);
      if (!options?.background) setExpandedGroups({});
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
      const res = await proxyPost("/dreaming/run", {});
      const data = await res.json() as { ok?: boolean; runId?: string; taskId?: string; status?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to start dreaming");
        return;
      }
      const runRef = data.runId ?? data.taskId;
      setNotice(`Dreaming started${runRef ? `: ${runRef}` : ""}`);
      // Don't loadDetail — the dispatcher hasn't created the run row
      // yet; loadHistory's background poll will surface it once the
      // scheduler tick claims the task.
      await loadHistory(true);
    } catch {
      setError("Failed to start dreaming");
    } finally {
      setStartingRun(false);
    }
  };

  // Phase 2a: dreams write through during the run, so there's no
  // separate Apply step. handleApply / handleApplyGoals removed; the
  // detail panel below renders a status badge instead of action buttons.

  // ── History view ──
  if (view === "history") {
    return (
      <div className="glass-card-strong p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Dreaming History</h2>
          <button type="button" onClick={() => setView("home")} className="text-xs text-foreground/60 hover:text-foreground/80 transition-colors">
            Back
          </button>
        </div>
        <div className="space-y-2">
          {groupedRuns.slice(0, visibleHistoryDays).map((group) => {
            const expanded = isHistoryDayExpanded(group.day);
            return (
              <div key={group.day} className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-foreground">{group.day}</div>
                    <div className="text-[10px] text-foreground/45">{group.runs.length} run(s)</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleGroup(`history:${group.day}`)}
                    className="text-[10px] text-foreground/55 hover:text-foreground/80 transition-colors"
                  >
                    {expanded ? "Collapse" : "Expand"}
                  </button>
                </div>
                {expanded && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 text-[10px] text-foreground/45">
                      <span>
                        {group.runs.length > DEFAULT_VISIBLE_RUNS_PER_DAY && !isHistoryDayShowingAll(group.day)
                          ? `Showing latest ${DEFAULT_VISIBLE_RUNS_PER_DAY} of ${group.runs.length}`
                          : `${group.runs.length} run(s)`}
                      </span>
                      {group.runs.length > DEFAULT_VISIBLE_RUNS_PER_DAY && (
                        <button
                          type="button"
                          onClick={() => toggleGroup(`history-all:${group.day}`)}
                          className="text-[10px] text-foreground/55"
                        >
                          {isHistoryDayShowingAll(group.day) ? "Show latest only" : "Show all runs"}
                        </button>
                      )}
                    </div>
                    <div className={`space-y-2 ${group.runs.length > DEFAULT_VISIBLE_RUNS_PER_DAY ? "max-h-72 overflow-y-auto pr-1" : ""}`}>
                    {(isHistoryDayShowingAll(group.day) ? group.runs : group.runs.slice(0, DEFAULT_VISIBLE_RUNS_PER_DAY)).map((run) => {
                      const activeSourceCount = Object.values(run.source_stats ?? {}).filter((item) => Number(item?.count ?? 0) > 0).length;
                      return (
                        <button
                          key={run.id}
                          type="button"
                          onClick={() => void loadDetail(run.id)}
                          className="w-full rounded-2xl bg-foreground/[0.04] px-3 py-3 text-left space-y-1 hover:bg-foreground/[0.07] transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-medium text-foreground">{formatDreamRunTitle(run)}</div>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(run.status)}`}>
                              {formatStatusLabel(run.status)}
                            </span>
                          </div>
                          <div className="text-[10px] text-foreground/35">{run.id}</div>
                          <div className="text-[11px] text-foreground/55">
                            {run.summary?.text ?? "No summary yet"}
                          </div>
                          <div className="flex flex-wrap gap-2 text-[10px] text-foreground/45">
                            <span>{run.trigger ?? "manual"}</span>
                            <span>{formatTimestamp(run.started_at)}</span>
                            <span>{activeSourceCount} active source(s)</span>
                            <span>{run.applied_at ? "Applied" : run.superseded ? "Superseded" : "Not applied"}</span>
                          </div>
                        </button>
                      );
                    })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {groupedRuns.length > visibleHistoryDays && (
            <button
              type="button"
              onClick={() => setVisibleHistoryDays((current) => current + DEFAULT_VISIBLE_HISTORY_DAYS)}
              className="w-full rounded-2xl bg-foreground/[0.06] px-3 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.10] transition-colors"
            >
              Load older days
            </button>
          )}
          {runs.length === 0 && (
            <p className="text-[11px] text-foreground/45">No dreaming runs yet.</p>
          )}
        </div>
      </div>
    );
  }

  // ── Detail view ──
  if (view === "detail" && detail) {
    return (
      <div className="glass-card-strong p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Dream Run Detail</h2>
            <p className="text-[11px] text-foreground/45 mt-1">{formatDreamRunTitle(detail.run)}</p>
            <p className="text-[10px] text-foreground/30 mt-1">{detail.run.id}</p>
          </div>
          <button type="button" onClick={() => setView("history")} className="text-xs text-foreground/60 hover:text-foreground/80 transition-colors">
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
            <span>Started {formatTimestamp(detail.run.started_at)}</span>
            <span>Completed {formatTimestamp(detail.run.completed_at)}</span>
            <span>{detail.run.applied_at ? "Profile applied" : "Profile pending apply"}</span>
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
          <h3 className="text-xs font-semibold text-foreground">Collected Context</h3>
          {normalizedGroups.length > 0 ? (
            normalizedGroups.map((group) => {
              const expanded = Boolean(expandedGroups[`normalized:${group.sourceId}`]);
              const visibleItems = expanded ? group.items : group.items.slice(0, DEFAULT_VISIBLE_ITEMS);
              return (
                <div key={`normalized-${group.sourceId}`} className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-foreground">
                      {group.sourceId} · {group.items.length} item(s)
                    </div>
                    {group.items.length > DEFAULT_VISIBLE_ITEMS && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(`normalized:${group.sourceId}`)}
                        className="text-[10px] text-foreground/55"
                      >
                        {expanded ? "Show less" : `Show all ${group.items.length}`}
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {visibleItems.map((item) => (
                      <div key={item.key} className="rounded-2xl bg-foreground/[0.04] px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-medium text-foreground">{item.title}</span>
                          {item.connector && (
                            <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] text-foreground/55">
                              {item.connector}
                            </span>
                          )}
                        </div>
                        {item.meta.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-foreground/40">
                            {item.meta.map((metaValue, index) => (
                              <span key={`${item.key}-meta-${index}`}>{metaValue}</span>
                            ))}
                          </div>
                        )}
                        <div className="mt-1 text-[11px] leading-5 text-foreground/60">{item.summary}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-[11px] text-foreground/45">No normalized input items for this run.</p>
          )}
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
            <pre className="max-h-48 overflow-auto rounded-2xl bg-foreground/[0.04] p-3 text-[10px] text-foreground/70 whitespace-pre-wrap">
              {detail.detail.logText || "No run logs yet."}
            </pre>
          </div>
        </details>

        <details className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Profile Diff</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-2xl bg-foreground/[0.04] p-3 text-[10px] text-foreground/70">
            {JSON.stringify(detail.detail.profileDelta, null, 2)}
          </pre>
        </details>

        <details className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Goal Diff</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-2xl bg-foreground/[0.04] p-3 text-[10px] text-foreground/70">
            {JSON.stringify(detail.detail.goalDelta, null, 2)}
          </pre>
        </details>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Goal Changes</h3>
          {(detail.detail.goalDelta?.changes ?? []).length > 0 ? (
            (detail.detail.goalDelta?.changes ?? []).map((change, index) => (
              <div key={`goal-change-${index}`} className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] text-foreground/55">
                    {String(change.action ?? "update")}
                  </span>
                  <span className="text-xs font-medium text-foreground">
                    {goalChangeTitle(change, index)}
                  </span>
                </div>
                <p className="text-[11px] text-foreground/55">{String(change.reason ?? "")}</p>
                <pre className="max-h-40 overflow-auto rounded-2xl bg-foreground/[0.04] p-3 text-[10px] text-foreground/70">
                  {JSON.stringify({ before: change.before ?? null, after: change.after ?? null }, null, 2)}
                </pre>
              </div>
            ))
          ) : (
            <p className="text-[11px] text-foreground/45">No goal changes for this run.</p>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Raw Connector Payloads</h3>
          {connectorGroups.length > 0 ? connectorGroups.map((group) => (
            <div key={`raw-${group.sourceId}`} className="space-y-2">
              {group.connectors.map((connector) => (
                <details key={`raw-${group.sourceId}-${connector.connectorId}`} className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
                  <summary className="cursor-pointer text-xs font-semibold text-foreground">
                    {connector.connectorId} · {connector.itemCount} item(s)
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-2xl bg-foreground/[0.04] p-3 text-[10px] text-foreground/70">
                    {JSON.stringify(connector.raw, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )) : (
            <details className="rounded-2xl bg-foreground/[0.04] px-3 py-3">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">Raw Inputs</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-2xl bg-foreground/[0.04] p-3 text-[10px] text-foreground/70">
                {JSON.stringify(detail.detail.rawInputs, null, 2)}
              </pre>
            </details>
          )}
        </div>

        {/* Phase 2a status badges — dreams write through automatically */}
        <div className="flex items-center justify-between rounded-2xl bg-foreground/[0.04] px-3 py-2 text-xs">
          <span className="text-foreground/70">Profile changes</span>
          <span className="font-medium text-foreground">
            {detail.run.status === "running"
              ? "Pending — dream still in progress"
              : detail.run.status === "failed"
                ? "Skipped — dream failed"
                : detail.run.applied_at
                  ? "Applied during the run"
                  : detail.run.superseded
                    ? "Superseded by a newer dream"
                    : "Applied"}
          </span>
        </div>

        <div className="flex items-center justify-between rounded-2xl bg-foreground/[0.04] px-3 py-2 text-xs">
          <span className="text-foreground/70">Goal changes</span>
          <span className="font-medium text-foreground">
            {detail.run.status === "running"
              ? "Pending — dream still in progress"
              : detail.run.status === "failed"
                ? "Skipped — dream failed"
                : detail.run.goals_applied_at
                  ? "Applied during the run"
                  : detail.run.superseded
                    ? "Superseded by a newer dream"
                    : "Applied"}
          </span>
        </div>
      </div>
    );
  }

  // ── Home view ──
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold text-foreground">Auto Dreaming</h3>
          <p className="text-[11px] text-foreground/42 mt-1">
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
            border border-foreground/10 transition-colors duration-200 ease-in-out
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
          <p className="text-[11px] text-foreground/60">{latestRun.summary?.text ?? "No summary yet."}</p>
          <p className="text-[10px] text-foreground/40">{formatTimestamp(latestRun.started_at)}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleRunDreaming()}
          disabled={startingRun || detailLoading}
          className="flex-1 rounded-2xl bg-primary px-3 py-2 text-xs font-medium text-background disabled:opacity-50 hover:bg-primary/85 transition-colors"
        >
          {startingRun ? "Starting..." : "Run Dreaming"}
        </button>
        <button
          type="button"
          onClick={() => void loadHistory()}
          className="flex-1 rounded-2xl bg-foreground/[0.06] px-3 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.10] transition-colors"
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
