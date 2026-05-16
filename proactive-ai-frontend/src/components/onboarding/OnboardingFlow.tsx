import { useCallback, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import AmbientSourceControlsPanel from "@/components/AmbientSourceControlsPanel";
import DataConnections from "@/components/DataConnections";
import { useComposio } from "@/hooks/useComposio";
import { isNative } from "@/lib/platform";

/**
 * First-run onboarding — two-step flow shown the first time a user lands
 * in the SPA. Gated by `settings.onboardingCompletedAt == null` in
 * App.tsx; the final action stamps that field server-side so subsequent
 * loads go straight to ConstellationLayout.
 *
 * Both steps allow Skip; we stamp completion only at the end of step 2,
 * so a mid-flow page reload restarts from step 1 (matches user intuition
 * for a wizard).
 *
 * `onComplete` is owned by App.tsx so the patch hits *its* useUserSettings
 * instance — useUserSettings has no global cache, so if we patched here
 * App's settings state would never refresh and the flow would never
 * dismiss.
 */

interface OnboardingFlowProps {
  onComplete: () => Promise<void> | void;
}

type Step = 1 | 2;

interface StepHeaderProps {
  step: Step;
  title: string;
  subtitle: string;
}

function StepHeader({ step, title, subtitle }: StepHeaderProps) {
  return (
    <div className="mb-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">
          Step {step} of 2
        </span>
        <div className="flex flex-1 items-center gap-1.5">
          <span className="h-1 flex-1 rounded-full bg-foreground/15">
            <span
              className="block h-full rounded-full bg-foreground transition-all"
              style={{ width: step === 1 ? "50%" : "100%" }}
            />
          </span>
        </div>
      </div>
      <h1 className="text-2xl font-semibold text-foreground tracking-tight">
        {title}
      </h1>
      <p className="mt-1 text-[13px] leading-relaxed text-foreground/55">
        {subtitle}
      </p>
    </div>
  );
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<Step>(1);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composio = useComposio();

  const finish = useCallback(async () => {
    setFinishing(true);
    setError(null);
    try {
      await onComplete();
      // On success App.tsx flips to ConstellationLayout — this component
      // unmounts before the next render so we don't clear local state.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setFinishing(false);
    }
  }, [onComplete]);

  return (
    <div className="relative flex h-full w-full items-stretch justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/30" />
      <div className="relative z-10 flex w-full max-w-xl flex-col px-5 pt-safe-top pb-safe-bottom">
        <div className="flex min-h-0 flex-1 flex-col py-6">
          {step === 1 ? (
            <>
              <StepHeader
                step={1}
                title="Ambient permissions"
                subtitle={
                  isNative
                    ? "Turn on the sensors PIN AI may observe. Each one stays off until you flip it; you can change this any time in Control Center."
                    : "Ambient sensors run on the iOS app. You can skip this step here and enable them later from your phone."
                }
              />
              <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto">
                <AmbientSourceControlsPanel />
              </div>
            </>
          ) : (
            <>
              <StepHeader
                step={2}
                title="Connect your data"
                subtitle="Pick the apps PIN AI can read from. You can connect more (or disconnect) any time from Control Center."
              />
              <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto">
                <section className="glass-card-strong p-4">
                  <DataConnections composio={composio} />
                </section>
              </div>
            </>
          )}
        </div>

        <div className="flex-shrink-0 pt-3">
          {error && (
            <p className="mb-2 text-right text-[12px] leading-snug text-red-500">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {step === 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="min-h-11 rounded-full px-4 text-[13px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06]"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-foreground px-5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
                >
                  Next
                  <ChevronRight size={15} strokeWidth={2} />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={finishing}
                  className="min-h-11 rounded-full px-4 text-[13px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06] disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void finish()}
                  disabled={finishing}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-foreground px-5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {finishing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
