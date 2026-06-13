import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import type { Connection } from "@pin-ai/state";
import { buildConnectorInitTaskId, buildConnectorPreviewTaskId } from "@pin-ai/state";
import { isInitTaskFresh, useInitTask, type InitTaskRow } from "@pin-ai/state";
import { proxyPost } from "@pin-ai/core";

export type ConnectorInsightStatus = "hidden" | "pending" | "ready" | "error";

interface ConnectorOnboardingInsightProps {
  connections: Connection[];
  mode?: "inline" | "page" | "watcher";
  onStatusChange?: (status: ConnectorInsightStatus, insightKey: string | null) => void;
  onContinue?: () => void;
  continueLabel?: string;
}

interface ConnectorSummarySection {
  title: string;
  bullets: string[];
}

interface ConnectorSummaryResponse {
  ok: boolean;
  source: {
    toolkit: string;
    connectedAccountId: string | null;
    itemCount: number;
  };
  summary: {
    displayName: string | null;
    headline: string;
    sections: ConnectorSummarySection[];
    note: string | null;
  };
  modelId: string;
}

type SummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: ConnectorSummaryResponse }
  | { status: "error"; message: string };

const summaryRequests = new Map<string, Promise<ConnectorSummaryResponse>>();
const RUNNING_TASK_STATUSES = new Set(["queued", "running"]);

interface InsightCandidate {
  connection: Connection;
  taskId: string;
  kind: "preview" | "init";
}

interface TaskReport {
  candidate: InsightCandidate;
  task: InitTaskRow | null;
  fresh: boolean;
}

const TOOLKIT_LABELS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Calendar",
  googledrive: "Drive",
  googledocs: "Docs",
  googlesheets: "Sheets",
  googlesuper: "Google Workspace",
  slack: "Slack",
  github: "GitHub",
  calendly: "Calendly",
  stripe: "Stripe",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

export default function ConnectorOnboardingInsight({
  connections,
  mode = "inline",
  onStatusChange,
  onContinue,
  continueLabel = "Continue setup",
}: ConnectorOnboardingInsightProps) {
  const activeConnections = useMemo(
    () =>
      connections.filter(
        (conn): conn is Connection & { connectedAccountId: string } =>
          conn.status === "ACTIVE" && Boolean(conn.connectedAccountId),
      ),
    [connections],
  );
  const candidates = useMemo(
    () =>
      activeConnections.flatMap((conn) => {
        const connectedAccountId = conn.connectedAccountId;
        return [
          {
            connection: conn,
            taskId: buildConnectorPreviewTaskId(conn.toolkit, connectedAccountId),
            kind: "preview" as const,
          },
          {
            connection: conn,
            taskId: buildConnectorInitTaskId(conn.toolkit, connectedAccountId),
            kind: "init" as const,
          },
        ];
      }),
    [activeConnections],
  );
  const [reports, setReports] = useState<Record<string, TaskReport>>({});
  const handleReport = useCallback((taskId: string, report: TaskReport) => {
    setReports((prev) => ({ ...prev, [taskId]: report }));
  }, []);
  const handleRemove = useCallback((taskId: string) => {
    setReports((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  useEffect(() => {
    const candidateKeys = new Set(candidates.map((candidate) => candidate.taskId));
    setReports((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => candidateKeys.has(key)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [candidates]);

  const selected = useMemo(() => selectInsightCandidate(candidates, reports), [candidates, reports]);

  useEffect(() => {
    if (candidates.length === 0) {
      onStatusChange?.("hidden", null);
    }
  }, [candidates.length, onStatusChange]);

  return (
    <>
      {candidates.map((conn) => (
        <ConnectorTaskProbe
          key={conn.taskId}
          candidate={conn}
          onReport={handleReport}
          onRemove={handleRemove}
        />
      ))}

      {selected ? (
        <ConnectorInsightCandidate
          key={selected.taskId}
          candidate={selected}
          mode={mode}
          connectedCount={activeConnections.length}
          onStatusChange={onStatusChange}
          onContinue={onContinue}
          continueLabel={continueLabel}
        />
      ) : null}
    </>
  );
}

function ConnectorTaskProbe({
  candidate,
  onReport,
  onRemove,
}: {
  candidate: InsightCandidate;
  onReport: (taskId: string, report: TaskReport) => void;
  onRemove: (taskId: string) => void;
}) {
  const { task } = useInitTask(candidate.taskId);
  const fresh = isInitTaskFresh(task);

  useEffect(() => {
    onReport(candidate.taskId, { candidate, task, fresh });
    return () => onRemove(candidate.taskId);
  }, [candidate, fresh, onRemove, onReport, task]);

  return null;
}

function ConnectorInsightCandidate({
  candidate,
  mode,
  connectedCount,
  onStatusChange,
  onContinue,
  continueLabel,
}: {
  candidate: InsightCandidate;
  mode: "inline" | "page" | "watcher";
  connectedCount: number;
  onStatusChange?: (status: ConnectorInsightStatus, insightKey: string | null) => void;
  onContinue?: () => void;
  continueLabel: string;
}) {
  const { connection } = candidate;
  const connectedAccountId = connection.connectedAccountId;
  const { task } = useInitTask(candidate.taskId);
  const [summaryState, setSummaryState] = useState<SummaryState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const requestedKeyRef = useRef<string | null>(null);

  const freshTask = isInitTaskFresh(task);
  const taskKey = `${candidate.taskId}:${task?.completed_at ?? ""}`;
  const label = toolkitLabel(connection.toolkit);

  useEffect(() => {
    if (!connectedAccountId || !task || !freshTask || task.status !== "succeeded") return;
    if (requestedKeyRef.current === taskKey) return;

    requestedKeyRef.current = taskKey;
    setDismissed(false);
    setSummaryState({ status: "loading" });
    onStatusChange?.("pending", taskKey);

    let cancelled = false;
    const run = async () => {
      try {
        const body = await loadConnectorSummary(
          taskKey,
          connection.toolkit,
          connectedAccountId,
          connection.label,
          connection.userInfo,
        );
        if (!cancelled) {
          setSummaryState({ status: "ready", data: body });
          onStatusChange?.("ready", taskKey);
        }
      } catch (err) {
        if (!cancelled) {
          setSummaryState({
            status: "error",
            message: err instanceof Error ? err.message : "Summary failed",
          });
          onStatusChange?.("error", taskKey);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [connectedAccountId, connection.toolkit, freshTask, onStatusChange, task, taskKey]);

  useEffect(() => {
    if (!task || !freshTask || task.status === "succeeded") return;
    const status = RUNNING_TASK_STATUSES.has(task.status) ? "pending" : "error";
    onStatusChange?.(status, `${connection.toolkit}:${connectedAccountId}:${task.completed_at ?? task.started_at ?? ""}`);
  }, [connectedAccountId, connection.toolkit, freshTask, onStatusChange, task]);

  if (dismissed || !task || !freshTask) return null;
  if (mode === "watcher" && summaryState.status !== "ready" && summaryState.status !== "error") return null;
  if (mode === "watcher") return null;

  if (task.status === "queued" || task.status === "running") {
    return (
      <InsightShell
        title="Reading your first connector items"
        icon={<Loader2 size={14} className="animate-spin" />}
        mode={mode}
        onDismiss={() => setDismissed(true)}
      >
        <p className="text-[12px] leading-5 text-foreground/55">
          {label} is connected. PIN AI is pulling recent data and will summarize it here while you keep setting up.
        </p>
      </InsightShell>
    );
  }

  if (task.status !== "succeeded") {
    return (
      <InsightShell
        title="Connector summary is not ready"
        icon={<XCircle size={14} />}
        tone="error"
        mode={mode}
        onDismiss={() => setDismissed(true)}
        onContinue={onContinue}
        continueLabel={continueLabel}
      >
        <p className="text-[12px] leading-5 text-foreground/55">
          The first {label} pull did not finish cleanly yet. You can continue onboarding and try again later.
        </p>
      </InsightShell>
    );
  }

  if (summaryState.status === "ready") {
    const { data } = summaryState;
    const sourceBadges = [
      `${data.source.itemCount} ${toolkitLabel(data.source.toolkit)} items`,
      ...(connectedCount > 1 ? [`${connectedCount - 1} more connected`] : []),
    ];
    return (
      <InsightShell
        title="Here's what we know about you"
        icon={<Sparkles size={14} />}
        badges={sourceBadges}
        mode={mode}
        onDismiss={() => setDismissed(true)}
        onContinue={onContinue}
        continueLabel={continueLabel}
      >
        <ConnectorSummaryContent data={data} mode={mode} />
      </InsightShell>
    );
  }

  if (summaryState.status === "error") {
    return (
      <InsightShell
        title="Summary failed"
        icon={<XCircle size={14} />}
        tone="error"
        mode={mode}
        onDismiss={() => setDismissed(true)}
        onContinue={onContinue}
        continueLabel={continueLabel}
      >
        <p className="text-[12px] leading-5 text-foreground/55">
          {summaryState.message}
        </p>
      </InsightShell>
    );
  }

  return (
    <InsightShell
      title="Summarizing what we found"
      icon={<Loader2 size={14} className="animate-spin" />}
      mode={mode}
      onDismiss={() => setDismissed(true)}
    >
      <p className="text-[12px] leading-5 text-foreground/55">
        PIN AI is distilling the recent {label} window into a short profile preview.
      </p>
    </InsightShell>
  );
}

function ConnectorSummaryContent({
  data,
  mode,
}: {
  data: ConnectorSummaryResponse;
  mode: "inline" | "page" | "watcher";
}) {
  if (mode !== "page") {
    return (
      <div className="space-y-4">
        <div className="border-b border-foreground/[0.06] pb-4">
          {data.summary.displayName && (
            <h2 className="text-[19px] font-semibold leading-snug text-foreground">
              {data.summary.displayName}
            </h2>
          )}
          <p className="mt-1.5 text-[13px] leading-5 text-foreground/62">
            {data.summary.headline}
          </p>
        </div>

        <div className="space-y-5">
          {data.summary.sections.map((section) => (
            <section key={section.title} className="space-y-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-foreground/48">
                {section.title}
              </h3>
              <ul className="space-y-2 text-[12.5px] leading-5 text-foreground/64">
                {section.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500/60" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {data.summary.note && (
          <div className="flex gap-2 border-t border-foreground/[0.06] pt-3 text-[11px] leading-4 text-foreground/42">
            <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" />
            <span>{data.summary.note}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="border-y border-foreground/[0.06] py-4">
        {data.summary.displayName && (
          <h2 className="text-[20px] font-semibold leading-snug text-foreground">
            {data.summary.displayName}
          </h2>
        )}
        <p className="mt-1.5 max-w-[34rem] text-[13.5px] leading-6 text-foreground/64">
          {data.summary.headline}
        </p>
      </div>

      <div className="space-y-1">
        {data.summary.sections.map((section) => {
          const Icon = summarySectionIcon(section.title);
          return (
            <section
              key={section.title}
              className="grid grid-cols-[2rem_1fr] gap-3 border-b border-foreground/[0.06] py-4 first:pt-0 last:border-b-0 last:pb-0"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-foreground/[0.045] text-foreground/50">
                <Icon size={15} strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/48">
                  {section.title}
                </h3>
                <ul className="mt-2.5 space-y-2.5 text-[13px] leading-5 text-foreground/68">
                  {section.bullets.map((bullet) => (
                    <li key={bullet} className="flex gap-2.5">
                      <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/[0.12] text-emerald-600">
                        <Check size={10.5} strokeWidth={2.4} />
                      </span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          );
        })}
      </div>

      {data.summary.note && (
        <div className="flex gap-2.5 rounded-2xl bg-foreground/[0.035] px-3 py-3 text-[11.5px] leading-4 text-foreground/48">
          <ShieldCheck size={14} className="mt-0.5 flex-shrink-0 text-foreground/45" />
          <span>{data.summary.note}</span>
        </div>
      )}
    </div>
  );
}

function summarySectionIcon(title: string) {
  const normalized = title.toLowerCase();
  if (normalized.includes("people") || normalized.includes("contact") || normalized.includes("account")) {
    return UsersRound;
  }
  if (normalized.includes("communicat") || normalized.includes("style")) {
    return MessageSquareText;
  }
  if (normalized.includes("identity") || normalized.includes("professional")) {
    return BriefcaseBusiness;
  }
  return Sparkles;
}

function InsightShell({
  title,
  icon,
  children,
  badges,
  mode,
  tone = "default",
  onDismiss,
  onContinue,
  continueLabel = "Continue setup",
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  badges?: string[];
  mode: "inline" | "page" | "watcher";
  tone?: "default" | "error";
  onDismiss: () => void;
  onContinue?: () => void;
  continueLabel?: string;
}) {
  const isPage = mode === "page";

  if (isPage) {
    return (
      <section className="glass-card-strong flex min-h-0 flex-1 flex-col overflow-hidden border border-foreground/[0.08]">
        <div className="flex flex-shrink-0 items-start gap-3 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div
            className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${
              tone === "error"
                ? "bg-red-500/[0.08] text-red-500"
                : "bg-emerald-500/[0.08] text-emerald-600"
            }`}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/34">
              Connector preview
            </p>
            <h2 className="max-w-[18rem] text-[24px] font-semibold leading-[1.08] tracking-tight text-foreground">
              {title}
            </h2>
            {badges && badges.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {badges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full bg-foreground/[0.055] px-2.5 py-1 text-[10.5px] font-medium leading-none text-foreground/50"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-6">
          {children}
        </div>

        {onContinue && (
          <div className="flex flex-shrink-0 justify-end border-t border-foreground/[0.06] px-5 py-4 sm:px-6">
            <button
              type="button"
              onClick={onContinue}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-foreground px-5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
            >
              {continueLabel}
              <ChevronRight size={15} strokeWidth={2} />
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="glass-card-strong mb-3 overflow-hidden border border-foreground/[0.08]">
      <div className="flex items-start gap-3 p-4">
        <div
          className={`mt-0.5 flex flex-shrink-0 items-center justify-center rounded-xl ${
            tone === "error"
              ? "bg-red-500/[0.08] text-red-500"
              : "bg-emerald-500/[0.08] text-emerald-600"
          } h-7 w-7`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/32">
              Connector preview
            </p>
            <h2 className="truncate text-sm font-semibold text-foreground">
              {title}
            </h2>
            {badges && badges.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {badges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full bg-foreground/[0.055] px-2 py-1 text-[10px] font-medium leading-none text-foreground/48"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3">{children}</div>
        </div>
        <button
          type="button"
          aria-label="Dismiss connector summary"
          onClick={onDismiss}
          className="rounded-lg p-1 text-foreground/30 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/60"
        >
          <X size={14} />
        </button>
      </div>
    </section>
  );
}

async function loadConnectorSummary(
  taskKey: string,
  toolkit: string,
  connectedAccountId: string,
  connectorLabel: string | null,
  connectorUserInfo: Record<string, unknown> | null,
): Promise<ConnectorSummaryResponse> {
  const existing = summaryRequests.get(taskKey);
  if (existing) return existing;

  const request = (async () => {
    const res = await proxyPost("/onboarding/connector-summary", {
      toolkit,
      connectedAccountId,
      connectorLabel,
      connectorUserInfo,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof body.detail === "string" ? body.detail : `Summary failed (${res.status})`;
      throw new Error(message);
    }
    if (!body.summary || !Array.isArray(body.summary.sections)) {
      throw new Error("Malformed summary response");
    }
    return body as ConnectorSummaryResponse;
  })();

  summaryRequests.set(taskKey, request);
  request.catch(() => {
    summaryRequests.delete(taskKey);
  });
  return request;
}

function selectInsightCandidate(
  candidates: InsightCandidate[],
  reports: Record<string, TaskReport>,
): InsightCandidate | null {
  if (candidates.length === 0 || Object.keys(reports).length === 0) {
    return null;
  }

  const freshReports = Object.values(reports).filter((report) => report.fresh && report.task);
  if (freshReports.length === 0) {
    return null;
  }

  const previewReports = freshReports.filter((report) => report.candidate.kind === "preview");
  const scopedReports = previewReports.length > 0 ? previewReports : freshReports;

  const succeeded = scopedReports.filter((report) => report.task?.status === "succeeded");
  const active = succeeded.length > 0
    ? succeeded
    : scopedReports.filter((report) => report.task?.status === "queued" || report.task?.status === "running");
  const pool = active.length > 0 ? active : scopedReports;

  return [...pool].sort(compareTaskReportPriority)[0]?.candidate ?? null;
}

function compareTaskReportPriority(a: TaskReport, b: TaskReport): number {
  const aKindScore = a.candidate.kind === "preview" ? 0 : 1;
  const bKindScore = b.candidate.kind === "preview" ? 0 : 1;
  if (aKindScore !== bKindScore) return aKindScore - bKindScore;

  const aToolkitScore = normalizedToolkit(a.candidate.connection.toolkit) === "googlesuper" ? 0 : 1;
  const bToolkitScore = normalizedToolkit(b.candidate.connection.toolkit) === "googlesuper" ? 0 : 1;
  if (aToolkitScore !== bToolkitScore) return aToolkitScore - bToolkitScore;

  const aTime = Date.parse(a.task?.completed_at ?? a.task?.started_at ?? "");
  const bTime = Date.parse(b.task?.completed_at ?? b.task?.started_at ?? "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

function toolkitLabel(toolkit: string): string {
  const key = normalizedToolkit(toolkit);
  return TOOLKIT_LABELS[key] ?? toolkit;
}

function normalizedToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase().replace(/[-_\s]/g, "");
}
