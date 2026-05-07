/**
 * Top-of-app pill showing in-flight agent runs.
 *
 * Refresh-safe: the pill renders entirely from useActiveAgentRuns, which
 * polls server state. F5 mid-run → pill is back instantly.
 *
 * Layout:
 *   - Hidden when there are zero in-flight runs (idle).
 *   - Single run → "<kind>" + spinner + elapsed.
 *   - Multiple runs → "N runs" + click to expand a dropdown listing each.
 *   - Just-finished (succeeded/failed in last 30s) → flashes briefly
 *     then the server-side window closes and they roll out.
 */
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import {
  useActiveAgentRuns,
  type ActiveAgentRun,
  type AgentRunKind,
  type AgentRunStatus,
} from "@/hooks/useActiveAgentRuns";

const KIND_LABEL: Record<AgentRunKind, string> = {
  "auto.dreaming": "Dreaming",
  "connector.init": "Connecting source",
  "connector.evolve": "Distilling signals",
  crystallize: "Crystallizing chat",
  generator: "Generating cards",
  "user.prompt": "Synthetic prompt",
};

function labelFor(kind: AgentRunKind): string {
  return KIND_LABEL[kind] ?? kind;
}

function statusIcon(status: AgentRunStatus) {
  if (status === "succeeded")
    return <CheckCircle2 size={12} className="text-emerald-600" />;
  if (status === "failed")
    return <XCircle size={12} className="text-red-500" />;
  return <Loader2 size={12} className="animate-spin text-foreground/55" />;
}

function elapsed(run: ActiveAgentRun, now: number): string {
  const startIso = run.startedAt ?? run.createdAt;
  if (!startIso) return "";
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "";
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export default function AgentRunIndicator() {
  const { runs } = useActiveAgentRuns();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick the elapsed clock every second so the pill text updates while
  // a run is in flight. Cheap (one setState per second). Skipped when
  // there's nothing visible to count for.
  useEffect(() => {
    if (runs.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [runs.length]);

  if (runs.length === 0) return null;

  const inflight = runs.filter(
    (r) => r.status === "queued" || r.status === "running",
  );
  const finished = runs.filter(
    (r) => r.status === "succeeded" || r.status === "failed",
  );
  const primary = inflight[0] ?? finished[0];

  // Compact mode: 1 run → text is the run summary. >1 → count summary.
  const summary =
    runs.length === 1
      ? labelFor(primary.kind)
      : `${inflight.length || runs.length} runs`;

  const inflightCount = inflight.length;
  const summaryDetail =
    runs.length === 1 && primary.status !== "succeeded" && primary.status !== "failed"
      ? elapsed(primary, now)
      : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full glass-card-strong px-3 py-1.5 text-[11px] font-medium text-foreground/70 transition-colors hover:bg-white/85"
        aria-label="Active agent runs"
      >
        {statusIcon(primary.status)}
        <span className="whitespace-nowrap">{summary}</span>
        {summaryDetail && (
          <span className="text-foreground/40 tabular-nums">{summaryDetail}</span>
        )}
        {runs.length > 1 && (
          <ChevronDown
            size={12}
            className={`text-foreground/40 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
        {inflightCount > 0 && runs.length > 1 && (
          <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums">
            {inflightCount}
          </span>
        )}
      </button>

      {open && runs.length > 0 && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-72 rounded-2xl glass-card-strong p-2 shadow-lg">
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground/45">
            Agent runs
          </div>
          <div className="space-y-1">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} now={now} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RunRow({ run, now }: { run: ActiveAgentRun; now: number }) {
  const isFinal = run.status === "succeeded" || run.status === "failed";
  return (
    <div
      className={`flex items-center gap-2 rounded-xl px-2 py-2 ${
        run.status === "failed"
          ? "bg-red-50/60"
          : run.status === "succeeded"
            ? "bg-emerald-50/60"
            : "bg-white/45"
      }`}
    >
      <div className="shrink-0">{statusIcon(run.status)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-foreground/80">
          {labelFor(run.kind)}
        </div>
        <div className="truncate text-[10px] text-foreground/45">
          {isFinal ? run.status : elapsed(run, now)}
          {run.lastError ? ` · ${run.lastError.slice(0, 80)}` : ""}
        </div>
      </div>
    </div>
  );
}
