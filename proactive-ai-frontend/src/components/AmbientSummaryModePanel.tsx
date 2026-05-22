import { useEffect, useMemo, useState } from "react";
import { Cloud, Cpu, LockKeyhole, Sparkles } from "lucide-react";
import {
  effectiveAmbientSummaryMode,
  loadAmbientSummaryPreference,
  saveAmbientSummaryPreference,
  subscribeAmbientSummaryPreference,
  type AmbientSummaryPreference,
} from "@/services/ambient/summary-preference";
import type { RuntimeStatus } from "@/services/ambient";

interface AmbientSummaryModePanelProps {
  runtimeStatus?: Pick<RuntimeStatus, "uploadsLocked"> | null;
}

const OPTIONS: Array<{
  value: AmbientSummaryPreference;
  title: string;
  description: string;
  icon: typeof Cloud;
}> = [
  {
    value: "cloud_when_unlocked",
    title: "Cloud when unlocked",
    description: "Use PIN AI cloud LLM for richer summaries when Upload Lock is off. Falls back to local if cloud is unavailable.",
    icon: Cloud,
  },
  {
    value: "local_only",
    title: "Local only",
    description: "Always summarize on this device. Requires an on-device LLM model.",
    icon: Cpu,
  },
];

export default function AmbientSummaryModePanel({ runtimeStatus }: AmbientSummaryModePanelProps) {
  const [preference, setPreference] = useState<AmbientSummaryPreference>(() => loadAmbientSummaryPreference());
  const uploadsLocked = runtimeStatus?.uploadsLocked === true;
  const effectiveMode = useMemo(
    () => effectiveAmbientSummaryMode({ uploadsLocked, preference }),
    [preference, uploadsLocked],
  );

  useEffect(() => subscribeAmbientSummaryPreference(setPreference), []);

  const handleSelect = (value: AmbientSummaryPreference) => {
    setPreference(value);
    saveAmbientSummaryPreference(value);
  };

  return (
    <section className="glass-card-strong p-4 space-y-3" data-testid="ambient-summary-mode-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Sparkles size={15} strokeWidth={1.8} className="text-foreground/55" />
            <h2 className="text-base font-semibold text-foreground">Summary mode</h2>
          </div>
          <p className="text-[12px] leading-relaxed text-foreground/55">
            Choose how Ambient turns local signals into short timeline summaries. Upload Lock always keeps summaries on device.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-foreground/10 bg-foreground/[0.04] px-2 py-1 text-[10px] font-semibold text-foreground/55">
          {effectiveMode === "cloud_llm" ? "Cloud active" : uploadsLocked ? "Local enforced" : "Local active"}
        </span>
      </div>

      {uploadsLocked && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] leading-snug text-amber-800">
          <LockKeyhole size={13} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          <p>Upload Lock is on. Cloud summaries are paused and local-only mode is enforced until you unlock uploads.</p>
        </div>
      )}

      <div className="grid gap-2">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = preference === option.value;
          const effective = selected && (
            !uploadsLocked || option.value === "local_only"
          );
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => handleSelect(option.value)}
              className={`min-h-11 rounded-xl border p-3 text-left transition-colors ${
                selected
                  ? "border-foreground/25 bg-foreground/[0.06]"
                  : "border-foreground/10 bg-foreground/[0.025] hover:bg-foreground/[0.04]"
              }`}
              aria-pressed={selected}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/60">
                  <Icon size={15} strokeWidth={1.8} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-[13px] font-semibold text-foreground">{option.title}</p>
                    {effective && (
                      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">Effective</span>
                    )}
                    {uploadsLocked && selected && option.value === "cloud_when_unlocked" && (
                      <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">After unlock</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-snug text-foreground/50">{option.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
