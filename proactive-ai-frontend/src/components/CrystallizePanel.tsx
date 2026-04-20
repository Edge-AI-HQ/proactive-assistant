/**
 * CrystallizePanel — debug-panel card for the conversation crystallize
 * pipeline. Shows progress (turn_count vs threshold), auto toggle, tunable
 * config (collapsible), skill counts, a Run-now button, and the most recent
 * crystallize decisions.
 */
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, ChevronDown, Play, Loader2, RefreshCw } from "lucide-react";
import { useCrystallize } from "@/hooks/useCrystallize";
import type { TunableCrystallizeKey } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CrystallizePanelProps {
  enabled: boolean;
}

const DECISION_STYLES: Record<string, string> = {
  memorize: "bg-emerald-50 text-emerald-700 border-emerald-200",
  create_skill: "bg-blue-50 text-blue-700 border-blue-200",
  discard: "bg-foreground/5 text-foreground/50 border-foreground/10",
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const diff = Date.now() - parsed;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function CrystallizePanel({ enabled }: CrystallizePanelProps) {
  const { state, loading, mutating, running, error, lastRun, refetch, toggleAuto, patchConfig, forceRun } =
    useCrystallize(enabled);
  const [tunablesOpen, setTunablesOpen] = useState(false);

  // Local draft values for number inputs so we can debounce onBlur commits.
  const [drafts, setDrafts] = useState<Partial<Record<TunableCrystallizeKey, string>>>({});

  useEffect(() => {
    if (!state) return;
    // Whenever effective config changes (e.g. after PATCH), sync drafts.
    setDrafts({
      messageThreshold: String(state.config.effective.messageThreshold ?? ""),
      cooldownMs: String(Math.round((state.config.effective.cooldownMs ?? 0) / 60_000)),
      salienceFloor: (state.config.effective.salienceFloor ?? 0).toFixed(2),
      minUserChars: String(state.config.effective.minUserChars ?? ""),
    });
  }, [state]);

  const threshold = state?.config.effective.messageThreshold ?? 10;
  const turnCount = state?.state.turn_count ?? 0;
  const progress = useMemo(() => Math.min(1, turnCount / Math.max(1, threshold)), [turnCount, threshold]);
  const autoEnabled = state?.settings.auto_crystallize ?? true;

  const commitNumber = async (key: TunableCrystallizeKey, raw: string) => {
    if (!state) return;
    const bounds = state.config.bounds[key];
    if (raw === "") {
      // Empty input clears the override back to default.
      await patchConfig({ [key]: null });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (n < bounds.min || n > bounds.max) return;
    if (bounds.integer && !Number.isInteger(n)) return;
    // For cooldown we stored minutes in the input — convert back to ms.
    const value = key === "cooldownMs" ? Math.round(n * 60_000) : n;
    if (value === state.config.effective[key]) return;
    await patchConfig({ [key]: value });
  };

  const resetAll = async () => {
    await patchConfig({
      messageThreshold: null,
      cooldownMs: null,
      salienceFloor: null,
      minUserChars: null,
    });
  };

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Sparkles size={14} strokeWidth={1.5} className="text-foreground/40" />
          <span className="text-xs font-medium text-foreground/50">Chat Learning</span>
          {loading && !state && (
            <Loader2 size={11} className="animate-spin text-foreground/30" strokeWidth={1.5} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refetch()}
            disabled={loading}
            title="Refresh"
            className="p-1 rounded-md text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 disabled:opacity-40"
          >
            <RefreshCw size={11} strokeWidth={1.5} className={loading ? "animate-spin" : ""} />
          </button>
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <span className="text-[10px] font-medium text-foreground/40">Auto</span>
            <input
              type="checkbox"
              checked={autoEnabled}
              disabled={!state || mutating}
              onChange={(e) => void toggleAuto(e.target.checked)}
              className="sr-only peer"
            />
            <span className="w-7 h-4 rounded-full bg-foreground/15 peer-checked:bg-emerald-500 relative transition-colors after:content-[''] after:absolute after:left-0.5 after:top-0.5 after:w-3 after:h-3 after:bg-white after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-3 peer-disabled:opacity-40" />
          </label>
        </div>
      </div>

      {/* Progress */}
      <div>
        <div className="flex items-baseline justify-between text-[10px] text-foreground/40 mb-1">
          <span>Turns</span>
          <span className="tabular-nums font-mono">
            {turnCount} / {threshold}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${progress * 100}%` }}
            transition={{ duration: 0.3 }}
            className={cn(
              "h-full rounded-full",
              progress >= 1 ? "bg-emerald-500" : "bg-foreground/50",
            )}
          />
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-foreground/40 mt-2">
          <span>Last bumped</span>
          <span className="tabular-nums text-right">{relativeTime(state?.state.last_message_at)}</span>
          <span>Last learned</span>
          <span className="tabular-nums text-right">{relativeTime(state?.state.last_crystallized_at)}</span>
        </div>
      </div>

      {/* Skills counters + Run Now */}
      <div className="flex items-center gap-2 mt-3">
        <div className="flex items-center gap-1 text-[10px] text-foreground/40 flex-1">
          <span className="font-medium">Skills:</span>
          <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-md">
            active {state?.skillCounts.active ?? 0}
          </span>
          {(state?.skillCounts.disabled ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-foreground/50 bg-foreground/10 px-1.5 py-0.5 rounded-md">
              disabled {state?.skillCounts.disabled}
            </span>
          )}
        </div>
        <button
          onClick={() => void forceRun()}
          disabled={!state || running || !enabled}
          className="inline-flex items-center gap-1 rounded-lg bg-foreground text-background text-[10px] font-semibold px-2.5 py-1 transition-colors hover:bg-foreground/85 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {running ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} strokeWidth={2} />}
          {running ? "Running…" : "Run now"}
        </button>
      </div>

      {lastRun && (
        <div className="mt-2 rounded-lg border border-foreground/10 bg-white/50 px-2 py-1.5 text-[10px] text-foreground/60 leading-snug">
          {lastRun.skipped ? (
            <>
              <span className="font-medium text-foreground/50">skipped</span>
              <span className="text-foreground/40"> — {lastRun.reason ?? "no reason"}</span>
            </>
          ) : (
            <>
              <span
                className={cn(
                  "font-semibold uppercase",
                  lastRun.decision === "memorize" && "text-emerald-700",
                  lastRun.decision === "create_skill" && "text-blue-700",
                  lastRun.decision === "discard" && "text-foreground/50",
                )}
              >
                {lastRun.decision ?? "done"}
              </span>
              {typeof lastRun.salience === "number" && (
                <span className="text-foreground/40"> · s={lastRun.salience.toFixed(2)}</span>
              )}
              {lastRun.memoryId && <span className="text-foreground/40"> · mem={lastRun.memoryId.slice(0, 8)}</span>}
              {lastRun.skillId && <span className="text-foreground/40"> · skill={lastRun.skillId.slice(0, 8)}</span>}
            </>
          )}
        </div>
      )}

      {/* Tunables (collapsible) */}
      <button
        onClick={() => setTunablesOpen((v) => !v)}
        className="w-full flex items-center justify-between mt-3 text-[10px] font-medium text-foreground/40 hover:text-foreground/60"
      >
        <span>Tunables</span>
        <ChevronDown
          size={12}
          strokeWidth={1.5}
          className={cn("transition-transform duration-200", tunablesOpen && "rotate-180")}
        />
      </button>
      <AnimatePresence>
        {tunablesOpen && state && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1.5 mt-2 text-[10px]">
              <TunableRow
                label="Threshold"
                unit="turns"
                draft={drafts.messageThreshold ?? ""}
                onChange={(v) => setDrafts((d) => ({ ...d, messageThreshold: v }))}
                onCommit={(v) => void commitNumber("messageThreshold", v)}
                bounds={state.config.bounds.messageThreshold}
                overridden={state.config.override.messageThreshold !== undefined}
              />
              <TunableRow
                label="Cooldown"
                unit="min"
                draft={drafts.cooldownMs ?? ""}
                onChange={(v) => setDrafts((d) => ({ ...d, cooldownMs: v }))}
                onCommit={(v) => void commitNumber("cooldownMs", v)}
                bounds={{
                  min: state.config.bounds.cooldownMs.min / 60_000,
                  max: state.config.bounds.cooldownMs.max / 60_000,
                  integer: true,
                }}
                overridden={state.config.override.cooldownMs !== undefined}
              />
              <TunableRow
                label="Salience floor"
                unit=""
                draft={drafts.salienceFloor ?? ""}
                step={0.05}
                onChange={(v) => setDrafts((d) => ({ ...d, salienceFloor: v }))}
                onCommit={(v) => void commitNumber("salienceFloor", v)}
                bounds={state.config.bounds.salienceFloor}
                overridden={state.config.override.salienceFloor !== undefined}
              />
              <TunableRow
                label="Min user chars"
                unit="chars"
                draft={drafts.minUserChars ?? ""}
                onChange={(v) => setDrafts((d) => ({ ...d, minUserChars: v }))}
                onCommit={(v) => void commitNumber("minUserChars", v)}
                bounds={state.config.bounds.minUserChars}
                overridden={state.config.override.minUserChars !== undefined}
              />
            </div>
            {Object.keys(state.config.override).length > 0 && (
              <button
                onClick={() => void resetAll()}
                disabled={mutating}
                className="mt-2 text-[10px] text-foreground/40 hover:text-foreground/70 underline disabled:opacity-40"
              >
                Reset all to default
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent decisions */}
      {state && state.recentDecisions.length > 0 && (
        <div className="mt-3">
          <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider block mb-1.5">
            Recent decisions
          </span>
          <div className="space-y-1">
            {state.recentDecisions.map((d, i) => (
              <div
                key={`${d.ts}-${i}`}
                className="flex items-start gap-1.5 rounded-lg bg-white/40 border border-foreground/10 px-2 py-1.5"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                    DECISION_STYLES[d.decision] ?? DECISION_STYLES.discard,
                  )}
                >
                  {d.decision}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-[10px] text-foreground/40">
                    {typeof d.salience === "number" && (
                      <span className="tabular-nums font-mono">s={d.salience.toFixed(2)}</span>
                    )}
                    <span className="tabular-nums">{relativeTime(d.ts)}</span>
                    {d.memoryId && <span className="text-foreground/30">· mem</span>}
                    {d.skillId && <span className="text-foreground/30">· skill</span>}
                  </div>
                  {d.summary && (
                    <p className="text-[10px] text-foreground/60 leading-snug line-clamp-2 mt-0.5">
                      {d.summary}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[10px] text-red-500 leading-snug">{error}</p>
      )}
    </div>
  );
}

interface TunableRowProps {
  label: string;
  unit: string;
  draft: string;
  step?: number;
  bounds: { min: number; max: number; integer: boolean };
  overridden: boolean;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}

function TunableRow({ label, unit, draft, step, bounds, overridden, onChange, onCommit }: TunableRowProps) {
  return (
    <>
      <span
        className={cn(
          "text-foreground/50",
          overridden && "font-semibold text-blue-600",
        )}
        title={overridden ? "Overridden from default" : undefined}
      >
        {label}
      </span>
      <input
        type="number"
        value={draft}
        min={bounds.min}
        max={bounds.max}
        step={step ?? (bounds.integer ? 1 : 0.01)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="rounded-md bg-white/60 border border-foreground/10 px-2 py-0.5 text-[10px] text-foreground font-mono tabular-nums w-full focus:outline-none focus:ring-1 focus:ring-primary/30"
      />
      <span className="text-[10px] text-foreground/30 whitespace-nowrap">{unit}</span>
    </>
  );
}
