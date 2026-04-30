/**
 * DebugPanel — slide-over panel triggered by gear icon in header.
 * Shows gateway health, "Open Gateway" button, pipeline phases, event log, run info.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings, Activity, Circle, Clock,
  ExternalLink, X, Zap, Cpu, MessageSquare, RefreshCw, Plug, Loader2,
} from "lucide-react";
import { Browser } from "@capacitor/browser";
import { getGatewayTicket, resetContainer, deleteAccount } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { isNative, API_BASE } from "@/lib/platform";
import { useModelSelection } from "@/hooks/useModelSelection";
import { useInitTask } from "@/hooks/useInitTask";
import MainChat from "./MainChat";
import CrystallizePanel from "./CrystallizePanel";
import SkillsPanel from "./SkillsPanel";
import MemoriesPanel from "./MemoriesPanel";
import type { HealthState, RunState, PipelinePhase } from "@/hooks/usePipeline";
import type { ComposioState } from "@/hooks/useComposio";

interface DebugPanelProps {
  health: HealthState;
  run: RunState;
  isRunning: boolean;
  onGenerate: () => void;
  composio: ComposioState;
}

const PHASES: PipelinePhase[] = ["planning", "generating", "evaluating", "complete"];
const PHASE_LABELS: Record<string, string> = {
  planning: "Planning",
  generating: "Generating",
  evaluating: "Evaluating",
  complete: "Complete",
};
const PHASE_HINTS: Record<string, string> = {
  planning: "Reading your profile & context...",
  generating: "Crafting intent cards...",
  evaluating: "Scoring relevance & quality...",
  complete: "Pipeline finished.",
};

function PhaseTimer({ isRunning }: { isRunning: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!isRunning) { setElapsed(0); return; }
    startRef.current = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  if (!isRunning) return null;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span className="text-xs text-foreground/40 tabular-nums font-mono">
      {mins > 0 ? `${mins}m ` : ""}{secs}s
    </span>
  );
}

function HealthPill({ health }: { health: HealthState }) {
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
  const activeIdx = PHASES.indexOf(activePhase as PipelinePhase);
  const thisIdx = PHASES.indexOf(phase as PipelinePhase);
  if (thisIdx < 0 || activeIdx < 0) return "pending";
  if (thisIdx < activeIdx) return "done";
  if (thisIdx === activeIdx) return "active";
  return "pending";
}

/** Renders one connected account row with a Reconnect button.
 *
 * Reconnect = re-enqueue connector.init for this (toolkit, account) pair
 * with a fresh idempotency key. Re-pulls 100 items, re-derives signals,
 * and re-runs the evolve agent. Existing raw / signal rows are kept;
 * dedupe_key absorbs duplicates so this is safe to spam.
 *
 * Uses useInitTask (read-only poll) to surface the resulting task's
 * status inline. The chip auto-stops polling when the task hits a
 * terminal state.
 */
function ConnectorReconnectRow({
  toolkit,
  identityLabel,
  connectedAccountId,
  onReconnect,
}: {
  toolkit: string;
  identityLabel: string;
  connectedAccountId: string;
  onReconnect: (toolkit: string, accountId: string) => Promise<{ ok: boolean; initTaskId?: string; error?: string }>;
}) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { task, terminal } = useInitTask(taskId);

  const handleClick = useCallback(async () => {
    setPending(true);
    setError(null);
    setTaskId(null);
    try {
      const result = await onReconnect(toolkit, connectedAccountId);
      if (!result.ok) {
        setError(result.error ?? "Reconnect failed");
      } else if (result.initTaskId) {
        setTaskId(result.initTaskId);
      }
    } finally {
      setPending(false);
    }
  }, [onReconnect, toolkit, connectedAccountId]);

  // Status chip text — terse, fits in the row's right edge.
  let chipText: string | null = null;
  let chipTone: "neutral" | "running" | "ok" | "fail" = "neutral";
  if (error) { chipText = error; chipTone = "fail"; }
  else if (pending) { chipText = "Enqueuing..."; chipTone = "running"; }
  else if (task) {
    if (task.status === "queued") { chipText = "Queued"; chipTone = "running"; }
    else if (task.status === "running") {
      const stage = (task.progress?.stage as string | undefined) ?? "running";
      chipText = `Running · ${stage}`;
      chipTone = "running";
    }
    else if (task.status === "succeeded") {
      const memWritten = (task.result?.memoriesWritten as number | undefined) ?? 0;
      const rawIns = (task.result?.rawInserted as number | undefined) ?? 0;
      chipText = `Done · ${rawIns} raw, ${memWritten} mem`;
      chipTone = "ok";
    }
    else if (task.status === "skipped") {
      chipText = `Skipped: ${(task.result?.reason as string | undefined) ?? "—"}`;
      chipTone = "neutral";
    }
    else { chipText = task.status; chipTone = "fail"; }
  }

  const chipClass = chipTone === "fail"
    ? "bg-red-100 text-red-600"
    : chipTone === "ok"
      ? "bg-emerald-100 text-emerald-700"
      : chipTone === "running"
        ? "bg-amber-100 text-amber-700"
        : "bg-foreground/10 text-foreground/60";
  const isWorking = pending || (task && !terminal);

  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-foreground/75 truncate">
          {toolkit}
          <span className="text-foreground/35 font-normal ml-1.5">{identityLabel}</span>
        </div>
        {chipText && (
          <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${chipClass}`}>
            {chipText}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={!!isWorking}
        title="Re-pull 100 items + re-run evolve. Existing raw rows are preserved."
        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-foreground/15 bg-white/55 px-2.5 py-1.5 text-[11px] font-medium text-foreground/65 transition-colors hover:bg-white/85 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWorking ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} strokeWidth={1.6} />}
        Reconnect
      </button>
    </div>
  );
}

export default function DebugPanel({ health, run, isRunning, onGenerate, composio }: DebugPanelProps) {
  const [open, setOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Only fetch model list when panel is open and gateway is healthy.
  const modelSelection = useModelSelection(open && health.ok);

  useEffect(() => {
    if (!open && !chatOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Chat overlay sits above the drawer — close it first.
      if (chatOpen) setChatOpen(false);
      else setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, chatOpen]);

  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = 0;
  }, [run.logEntries.length]);

  const openGateway = useCallback(async () => {
    setGatewayLoading(true);
    try {
      const { url } = await getGatewayTicket();
      // API returns a relative path; native browser needs an absolute URL.
      const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
      if (isNative) {
        await Browser.open({ url: fullUrl, presentationStyle: "popover" });
      } else {
        window.open(url, "_blank");
      }
    } catch (err) {
      console.error("Failed to get gateway ticket:", err);
      if (isNative) {
        alert(`Gateway error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setGatewayLoading(false);
    }
  }, []);

  const handleResetContainer = useCallback(async () => {
    if (!confirm("Reset container? This will destroy the current container and create a new one.")) return;
    setResetLoading(true);
    try {
      await resetContainer();
      window.location.reload();
    } catch (err) {
      console.error("Failed to reset container:", err);
      alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetLoading(false);
    }
  }, []);

  const handleDeleteAccount = useCallback(async () => {
    if (!confirm("Are you sure you want to delete your account? This will destroy your container, volume, and all user data. This cannot be undone.")) return;
    setDeleteLoading(true);
    try {
      await deleteAccount();
      await supabase.auth.signOut();
      window.location.replace("/proactive/");
    } catch (err) {
      console.error("Failed to delete account:", err);
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleteLoading(false);
    }
  }, []);

  return (
    <>
      {/* Gear icon trigger */}
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded-full glass-card-strong"
        title="Debug Panel"
      >
        <Settings size={18} strokeWidth={1.5} className="text-foreground/70" />
      </button>

      {/* Backdrop + slide-over */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-black/20 z-40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed right-0 top-0 bottom-0 w-[380px] bg-white/80 backdrop-blur-2xl border-l border-foreground/10 shadow-2xl z-50 flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-safe-top pb-3">
                <h2 className="text-lg font-semibold text-foreground">Debug</h2>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-foreground/10 text-foreground/40 hover:text-foreground/70"
                >
                  <X size={18} strokeWidth={1.5} />
                </button>
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-4">
                {/* Gateway Health */}
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity size={14} strokeWidth={1.5} className="text-foreground/40" />
                      <span className="text-xs font-medium text-foreground/50">Gateway</span>
                    </div>
                    <HealthPill health={health} />
                  </div>
                  {health.error && (
                    <p className="text-[11px] text-red-500 mt-2 leading-snug">{health.error}</p>
                  )}
                  <button
                    onClick={openGateway}
                    disabled={!health.ok || gatewayLoading}
                    className="mt-2.5 w-full flex items-center justify-center gap-1.5 rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/50 hover:text-foreground/70 text-[11px] font-medium py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ExternalLink size={12} strokeWidth={1.5} />
                    {gatewayLoading ? "Opening..." : "Open Gateway"}
                  </button>
                  <button
                    onClick={() => setChatOpen(true)}
                    disabled={!health.ok}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/50 hover:text-foreground/70 text-[11px] font-medium py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <MessageSquare size={12} strokeWidth={1.5} />
                    Open Main Chat
                  </button>
                </div>

                {/* Model Selection */}
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2">
                      <Cpu size={14} strokeWidth={1.5} className="text-foreground/40" />
                      <span className="text-xs font-medium text-foreground/50">Model</span>
                    </div>
                    {modelSelection.changing && (
                      <span className="text-[10px] text-foreground/40">Applying…</span>
                    )}
                  </div>
                  {modelSelection.loading && modelSelection.models.length === 0 ? (
                    <p className="text-[11px] text-foreground/30 py-1">Loading models…</p>
                  ) : modelSelection.models.length === 0 ? (
                    <p className="text-[11px] text-foreground/40 py-1">
                      {health.ok ? "No models configured" : "Gateway unavailable"}
                    </p>
                  ) : (
                    <select
                      value={modelSelection.currentModel ?? ""}
                      disabled={
                        isRunning ||
                        modelSelection.changing ||
                        modelSelection.loading ||
                        !health.ok
                      }
                      onChange={(e) => { void modelSelection.change(e.target.value); }}
                      title={isRunning ? "Pipeline is running — cannot switch model" : undefined}
                      className="w-full rounded-lg bg-white/60 border border-foreground/10 px-2.5 py-1.5 text-[16px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {modelSelection.models.map((m) => (
                        <option key={m.ref} value={m.ref}>
                          {m.id}
                          {m.ref === modelSelection.defaultModel ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {modelSelection.error && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] text-red-500 leading-snug flex-1">
                        {modelSelection.error}
                      </p>
                      <button
                        onClick={() => { void modelSelection.retry(); }}
                        className="text-[11px] font-medium text-foreground/50 hover:text-foreground/70 underline shrink-0"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>

                {/* Generate Controls */}
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Zap size={14} strokeWidth={1.5} className="text-foreground/40" />
                    <span className="text-xs font-medium text-foreground/50">Generate Cards</span>
                  </div>
                  <button
                    onClick={onGenerate}
                    disabled={isRunning || !health.ok}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-foreground text-background text-[11px] font-semibold py-1.5 transition-colors hover:bg-foreground/85 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Zap size={12} strokeWidth={2} />
                    {isRunning ? "Running..." : "Generate"}
                  </button>
                </div>

                {/* Phase Strip */}
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[11px] font-medium text-foreground/40 uppercase tracking-wider">
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
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-foreground/10 text-foreground/40"
                          }`}
                        >
                          {PHASE_LABELS[phase]}
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
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5 flex flex-col" style={{ maxHeight: 260 }}>
                  <div className="flex items-center gap-2 mb-2.5">
                    <Clock size={12} strokeWidth={1.5} className="text-foreground/40" />
                    <span className="text-[11px] font-medium text-foreground/40 uppercase tracking-wider">
                      Event Log
                    </span>
                    <span className="text-[10px] text-foreground/30 ml-auto tabular-nums">
                      {run.logEntries.length} events
                    </span>
                  </div>
                  <div ref={logContainerRef} className="flex-1 overflow-y-auto space-y-0 pr-1">
                    {run.logEntries.length === 0 && (
                      <p className="text-[11px] text-foreground/30 py-4 text-center">No events yet</p>
                    )}
                    <AnimatePresence initial={false}>
                      {[...run.logEntries].reverse().map((entry) => (
                        <motion.div
                          key={entry.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="relative pl-3 py-1.5 border-l-2 border-foreground/10"
                        >
                          <div className="absolute left-[-3.5px] top-3 w-[5px] h-[5px] rounded-full bg-foreground/30" />
                          <div className="flex items-baseline gap-2">
                            <span className="text-[10px] text-foreground/30 tabular-nums font-mono shrink-0">
                              {new Date(entry.timestamp).toLocaleTimeString([], {
                                hour: "2-digit", minute: "2-digit", second: "2-digit",
                              })}
                            </span>
                            <span className="text-[10px] font-medium text-foreground/40 bg-foreground/10 px-1.5 py-0.5 rounded-md shrink-0">
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

                {/* Conversation Crystallize */}
                <CrystallizePanel enabled={open && health.ok} />

                {/* User Skills */}
                <SkillsPanel enabled={open && health.ok} />

                {/* User Memories */}
                <MemoriesPanel enabled={open && health.ok} />

                {/* Run Info */}
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
                  <span className="text-[11px] font-medium text-foreground/40 uppercase tracking-wider block mb-2">
                    Run Info
                  </span>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                    <span className="text-foreground/40">Status</span>
                    <span className="text-foreground/70 font-medium">{run.status || "\u2014"}</span>

                    <span className="text-foreground/40">Started</span>
                    <span className="text-foreground/50 tabular-nums font-mono">
                      {run.startedAt
                        ? new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                        : "\u2014"}
                    </span>

                    <span className="text-foreground/40">Completed</span>
                    <span className="text-foreground/50 tabular-nums font-mono">
                      {run.completedAt
                        ? new Date(run.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                        : "\u2014"}
                    </span>

                    <span className="text-foreground/40">Final Cards</span>
                    <span className="text-foreground/70 font-medium">{run.finalCards.length}</span>
                  </div>
                  {run.error && (
                    <div className="mt-2.5 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                      <p className="text-[11px] text-red-600 leading-snug">{run.error}</p>
                    </div>
                  )}
                </div>

                {/* Connectors — Reconnect button per ACTIVE account */}
                <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Plug size={14} strokeWidth={1.5} className="text-foreground/40" />
                    <span className="text-xs font-medium text-foreground/50">Connectors</span>
                    <span className="text-[10px] text-foreground/30 ml-auto tabular-nums">
                      {composio.connections.filter((c) => c.status === "ACTIVE").length} active
                    </span>
                  </div>
                  <p className="text-[10px] leading-relaxed text-foreground/40 mb-2">
                    Reconnect re-pulls 100 items and re-runs evolve for that account. Existing raw rows are kept.
                  </p>
                  {composio.loadingConns && composio.connections.length === 0 ? (
                    <p className="text-[11px] text-foreground/30 py-2">Loading connections…</p>
                  ) : composio.connections.filter((c) => c.status === "ACTIVE").length === 0 ? (
                    <p className="text-[11px] text-foreground/40 py-2">
                      No active connections. Visit the Data Connections page to set one up.
                    </p>
                  ) : (
                    <div className="divide-y divide-foreground/5">
                      {composio.connections
                        .filter((conn) => conn.status === "ACTIVE" && conn.connectedAccountId)
                        .map((conn) => {
                          const accountId = conn.connectedAccountId as string;
                          const info = conn.userInfo ?? {};
                          const pickIdentity = (...keys: string[]): string => {
                            for (const key of keys) {
                              const v = info[key];
                              if (typeof v === "string" && v.trim()) return v;
                            }
                            return `…${accountId.slice(-6)}`;
                          };
                          const identity = pickIdentity("email", "username", "handle", "name", "display_name");
                          return (
                            <ConnectorReconnectRow
                              key={accountId}
                              toolkit={conn.toolkit}
                              identityLabel={identity}
                              connectedAccountId={accountId}
                              onReconnect={composio.reconnectAccount}
                            />
                          );
                        })}
                    </div>
                  )}
                </div>

                {/* Danger Zone */}
                <div className="rounded-xl border border-red-200 bg-red-50/50 p-3.5">
                  <span className="text-[11px] font-medium text-red-400 uppercase tracking-wider block mb-2">
                    Danger Zone
                  </span>
                  <button
                    onClick={handleResetContainer}
                    disabled={resetLoading}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-red-300 text-red-600 text-[11px] font-medium py-2 mb-2 transition-colors hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {resetLoading ? "Resetting..." : "Reset Container"}
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deleteLoading}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-[11px] font-medium py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deleteLoading ? "Deleting..." : "Delete Account"}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {chatOpen && (
        <div className="fixed inset-0 z-[60] bg-background">
          <MainChat onBack={() => setChatOpen(false)} />
        </div>
      )}
    </>
  );
}
