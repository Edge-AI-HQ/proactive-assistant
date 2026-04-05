import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, Activity, Circle, Clock, Hash, ChevronDown } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";

interface DebugPanelProps {
  health: {
    loading: boolean;
    ok: boolean;
    pipelineRunning: boolean;
    error: string | null;
  };
  run: {
    status: string;
    maxIterations: number | null;
    activeIteration: number | null;
    activePhase: string | null;
    startedAt: string | null;
    completedAt: string | null;
    finalCards: any[];
    iterationDetails: Record<number, { cards?: any[]; evaluation?: any }>;
    logEntries: {
      id: string;
      kind: string;
      title: string;
      detail: string;
      timestamp: string;
    }[];
    error: string | null;
    totalIterations: number;
  };
  iterations: number;
  onIterationsChange: (n: number) => void;
  onGenerate: () => void;
  isRunning: boolean;
}

const PHASES = ["Planning", "Generating", "Evaluating", "Complete"] as const;

const PHASE_HINTS: Record<string, string> = {
  Planning: "Reading your profile & context...",
  Generating: "Crafting intent cards...",
  Evaluating: "Scoring relevance & quality...",
  Complete: "Pipeline finished.",
};

function PhaseTimer({ isRunning }: { isRunning: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!isRunning) {
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  if (!isRunning) return null;

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <span className="text-xs text-foreground/40 tabular-nums font-mono">
      {mins > 0 ? `${mins}m ` : ""}
      {secs}s
    </span>
  );
}

function HealthPill({ health }: Pick<DebugPanelProps, "health">) {
  if (health.loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium bg-amber-100 text-amber-700">
        <Circle size={6} fill="currentColor" className="animate-pulse" />
        Checking
      </span>
    );
  }
  if (health.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium bg-emerald-100 text-emerald-700">
        <Circle size={6} fill="currentColor" />
        OK
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium bg-red-100 text-red-600">
      <Circle size={6} fill="currentColor" />
      Unavailable
    </span>
  );
}

function phaseStatus(phase: string, activePhase: string | null, status: string) {
  if (status === "complete" || status === "done") return "done";
  if (!activePhase) return "pending";

  const activeIdx = PHASES.indexOf(activePhase as (typeof PHASES)[number]);
  const thisIdx = PHASES.indexOf(phase as (typeof PHASES)[number]);
  if (thisIdx < 0 || activeIdx < 0) return "pending";
  if (thisIdx < activeIdx) return "done";
  if (thisIdx === activeIdx) return "active";
  return "pending";
}

export default function DebugPanel({
  health,
  run,
  iterations,
  onIterationsChange,
  onGenerate,
  isRunning,
}: DebugPanelProps) {
  const [expandedIter, setExpandedIter] = useState<number | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [run.logEntries.length]);

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="p-2 rounded-xl hover:bg-foreground/5 transition-colors text-foreground/50 hover:text-foreground/80">
          <Settings size={18} strokeWidth={1.5} />
        </button>
      </SheetTrigger>

      <SheetContent
        side="right"
        className="w-[380px] sm:max-w-[380px] bg-background/80 backdrop-blur-2xl border-l border-white/20 p-0 overflow-hidden"
      >
        <div className="flex flex-col h-full overflow-y-auto px-5 pt-6 pb-5">
          {/* Title */}
          <h2 className="text-display text-lg text-foreground mb-4">Debug</h2>

          {/* Gateway Health */}
          <div className="glass-card p-3.5 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity size={14} strokeWidth={1.5} className="text-foreground/50" />
                <span className="text-xs font-medium text-foreground/70">Gateway</span>
              </div>
              <HealthPill health={health} />
            </div>
            {health.error && (
              <p className="text-[11px] text-red-500/80 mt-2 leading-snug">{health.error}</p>
            )}
          </div>

          {/* Iterations + Generate */}
          <div className="glass-card p-3.5 mb-4">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-[11px] font-medium text-foreground/50 uppercase tracking-wider mb-1.5 block">
                  Iterations
                </label>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={iterations}
                  onChange={(e) => {
                    const v = Math.min(8, Math.max(1, Number(e.target.value) || 1));
                    onIterationsChange(v);
                  }}
                  disabled={isRunning}
                  className="w-full rounded-xl bg-foreground/5 border border-foreground/10 px-3 py-2 text-sm text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-40"
                />
              </div>
              <div className="flex-1 flex flex-col justify-end">
                <button
                  onClick={onGenerate}
                  disabled={isRunning || !health.ok}
                  className="w-full mt-5 rounded-xl bg-foreground text-background text-sm font-semibold py-2.5 hover:bg-foreground/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isRunning ? "Running..." : "Generate"}
                </button>
              </div>
            </div>
          </div>

          {/* Phase Strip */}
          <div className="glass-card p-3.5 mb-4">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] font-medium text-foreground/50 uppercase tracking-wider">
                Pipeline Phases
              </span>
              <PhaseTimer isRunning={isRunning} />
            </div>
            <div className="flex items-center gap-1.5">
              {PHASES.map((phase) => {
                const s = phaseStatus(phase, run.activePhase, run.status);
                return (
                  <span
                    key={phase}
                    className={`flex-1 text-center text-[10px] font-semibold py-1.5 rounded-full transition-all duration-300 ${
                      s === "active"
                        ? "bg-blue-500 text-white animate-pulse"
                        : s === "done"
                          ? "bg-emerald-500/20 text-emerald-700"
                          : "bg-foreground/5 text-foreground/35"
                    }`}
                  >
                    {phase}
                  </span>
                );
              })}
            </div>
            {isRunning && run.activePhase && (
              <p className="text-[11px] text-foreground/40 mt-2.5 italic">
                {PHASE_HINTS[run.activePhase] ?? "Processing..."}
              </p>
            )}
          </div>

          {/* Live Event Log */}
          <div className="glass-card p-3.5 mb-4 flex flex-col" style={{ maxHeight: 260 }}>
            <div className="flex items-center gap-2 mb-2.5">
              <Clock size={12} strokeWidth={1.5} className="text-foreground/50" />
              <span className="text-[11px] font-medium text-foreground/50 uppercase tracking-wider">
                Event Log
              </span>
              <span className="text-[10px] text-foreground/30 ml-auto tabular-nums">
                {run.logEntries.length} events
              </span>
            </div>
            <div ref={logContainerRef} className="flex-1 overflow-y-auto space-y-0 pr-1">
              {run.logEntries.length === 0 && (
                <p className="text-[11px] text-foreground/25 py-4 text-center">No events yet</p>
              )}
              <AnimatePresence initial={false}>
                {[...run.logEntries].reverse().map((entry) => (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="relative pl-3 py-1.5 border-l-2 border-foreground/8"
                  >
                    <div className="absolute left-[-3.5px] top-3 w-[5px] h-[5px] rounded-full bg-foreground/20" />
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] text-foreground/30 tabular-nums font-mono shrink-0">
                        {new Date(entry.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className="text-[10px] font-medium text-foreground/40 bg-foreground/5 px-1.5 py-0.5 rounded-md shrink-0">
                        {entry.kind}
                      </span>
                    </div>
                    <p className="text-[12px] text-foreground/70 font-medium leading-snug mt-0.5">
                      {entry.title}
                    </p>
                    {entry.detail && (
                      <p className="text-[11px] text-foreground/40 leading-snug mt-0.5 line-clamp-2">
                        {entry.detail}
                      </p>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>

          {/* Iteration Summaries */}
          {run.totalIterations > 0 && (
            <div className="glass-card p-3.5 mb-4">
              <div className="flex items-center gap-2 mb-2.5">
                <Hash size={12} strokeWidth={1.5} className="text-foreground/50" />
                <span className="text-[11px] font-medium text-foreground/50 uppercase tracking-wider">
                  Iterations
                </span>
              </div>
              <div className="space-y-1">
                {Array.from({ length: run.totalIterations }, (_, i) => i + 1).map((n) => {
                  const detail = run.iterationDetails[n];
                  const cardCount = detail?.cards?.length ?? 0;
                  const evalResult = detail?.evaluation;
                  const isOpen = expandedIter === n;

                  let passCount = 0;
                  let failCount = 0;
                  if (evalResult && typeof evalResult === "object") {
                    if (Array.isArray(evalResult)) {
                      passCount = evalResult.filter((e: any) => e.pass || e.passed).length;
                      failCount = evalResult.length - passCount;
                    } else if (evalResult.pass !== undefined) {
                      passCount = evalResult.pass ? 1 : 0;
                      failCount = evalResult.pass ? 0 : 1;
                    }
                  }

                  return (
                    <div key={n}>
                      <button
                        onClick={() => setExpandedIter(isOpen ? null : n)}
                        className="w-full flex items-center gap-2 rounded-xl bg-foreground/[0.03] hover:bg-foreground/[0.06] px-3 py-2 transition-colors"
                      >
                        <span className="text-xs font-semibold text-foreground/60 w-5">#{n}</span>
                        <span className="text-[11px] text-foreground/50 flex-1 text-left">
                          {cardCount} card{cardCount !== 1 ? "s" : ""}
                        </span>
                        {evalResult && (
                          <div className="flex items-center gap-1.5">
                            {passCount > 0 && (
                              <span className="text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                                {passCount} pass
                              </span>
                            )}
                            {failCount > 0 && (
                              <span className="text-[10px] font-medium text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded-full">
                                {failCount} fail
                              </span>
                            )}
                          </div>
                        )}
                        <ChevronDown
                          size={12}
                          strokeWidth={1.5}
                          className={`text-foreground/25 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      <AnimatePresence>
                        {isOpen && detail && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-3 py-2 text-[11px] text-foreground/40 space-y-1">
                              {detail.cards?.map((card: any, ci: number) => (
                                <div key={ci} className="flex items-center gap-1.5">
                                  <span className="w-1 h-1 rounded-full bg-foreground/20 shrink-0" />
                                  <span className="truncate">{card.title ?? card.name ?? `Card ${ci + 1}`}</span>
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Run Metadata */}
          <div className="glass-card p-3.5">
            <span className="text-[11px] font-medium text-foreground/50 uppercase tracking-wider block mb-2">
              Run Info
            </span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              <span className="text-foreground/40">Status</span>
              <span className="text-foreground/70 font-medium">{run.status || "—"}</span>

              <span className="text-foreground/40">Started</span>
              <span className="text-foreground/60 tabular-nums font-mono">
                {run.startedAt
                  ? new Date(run.startedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "—"}
              </span>

              <span className="text-foreground/40">Completed</span>
              <span className="text-foreground/60 tabular-nums font-mono">
                {run.completedAt
                  ? new Date(run.completedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "—"}
              </span>

              <span className="text-foreground/40">Final Cards</span>
              <span className="text-foreground/70 font-medium">{run.finalCards.length}</span>
            </div>
            {run.error && (
              <div className="mt-2.5 rounded-xl bg-red-50/60 border border-red-200/40 px-3 py-2">
                <p className="text-[11px] text-red-600/80 leading-snug">{run.error}</p>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
