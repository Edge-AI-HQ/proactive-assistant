import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Database, Loader2, Sparkles, UserRound } from "lucide-react";
import AmbientSourceControlsPanel from "@/components/ambient/AmbientSourceControlsPanel";
import VoiceIdentitySettings from "@/components/account/VoiceIdentitySettings";
import AmbientModelSetupStep from "./AmbientModelSetupStep";
import DataConnections from "@/components/connect/DataConnections";
import ConnectorOnboardingInsight, {
  type ConnectorInsightStatus,
} from "@/components/connect/ConnectorOnboardingInsight";
import { useComposio } from "@/hooks/useComposio";
import { isNative } from "@/lib/platform";

/**
 * First-run onboarding — three-step flow shown the first time a user lands
 * in the SPA. Gated by `settings.onboardingCompletedAt == null` in
 * App.tsx; the final action stamps that field server-side so subsequent
 * loads go straight to AppLayout.
 *
 * All steps allow Skip; we stamp completion only at the end of step 3,
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

type Step = 1 | 2 | 3;
type ExitStage = "flow" | "waiting" | "summary";

const INSIGHT_WAIT_GRACE_MS = 800;

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
          Step {step} of 3
        </span>
        <div className="flex flex-1 items-center gap-1.5">
          <span className="h-1 flex-1 rounded-full bg-foreground/15">
            <span
              className="block h-full rounded-full bg-foreground transition-all"
              style={{ width: `${(step / 3) * 100}%` }}
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

function InsightWaitPage() {
  const steps = [
    {
      label: "Reading recent items",
      detail: "Pulling the newest connector records into a small working set.",
      icon: Database,
    },
    {
      label: "Finding useful signals",
      detail: "Looking for work patterns, collaborators, tools, and writing style.",
      icon: Sparkles,
    },
    {
      label: "Composing your preview",
      detail: "Turning the first pull into a short profile you can review.",
      icon: UserRound,
    },
  ];

  return (
    <section className="glass-card-strong flex min-h-0 flex-1 flex-col overflow-hidden border border-foreground/[0.08]">
      <div className="flex flex-shrink-0 items-start gap-3 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
        <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500/[0.08] text-emerald-600">
          <Loader2 size={15} className="animate-spin" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/34">
            Connector preview
          </p>
          <h1 className="max-w-[18rem] text-[24px] font-semibold leading-[1.08] tracking-tight text-foreground">
            PIN AI is getting to know your work context
          </h1>
          <p className="mt-3 max-w-sm text-[13px] leading-5 text-foreground/55">
            We are turning your first connector pull into a concise profile preview.
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5 sm:px-6">
        <div className="rounded-[24px] border border-foreground/[0.07] bg-white/45 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/42">
              First data pull
            </span>
            <span className="rounded-full bg-foreground/[0.055] px-2.5 py-1 text-[10px] font-medium leading-none text-foreground/45">
              Live
            </span>
          </div>

          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
            <div className="h-full w-2/3 animate-pulse rounded-full bg-foreground/70" />
          </div>

          <div className="mt-5 space-y-4">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <div
                  key={step.label}
                  className="grid grid-cols-[2rem_1fr_auto] items-start gap-3"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-foreground/[0.045] text-foreground/50">
                    <Icon size={15} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold leading-5 text-foreground/76">
                      {step.label}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-4 text-foreground/45">
                      {step.detail}
                    </span>
                  </span>
                  <span className="mt-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/[0.10] text-emerald-600">
                    <Loader2 size={11} className="animate-spin" />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-shrink-0 gap-2.5 border-t border-foreground/[0.06] px-5 py-4 text-[11.5px] leading-4 text-foreground/48 sm:px-6">
        <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-foreground/45" />
        <div>
          You will review this preview before entering PIN AI. The result page replaces this state as soon as it is ready.
        </div>
      </div>
    </section>
  );
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<Step>(1);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exitStage, setExitStage] = useState<ExitStage>("flow");
  const [activeInsightKey, setActiveInsightKey] = useState<string | null>(null);
  const [insightStatus, setInsightStatus] = useState<ConnectorInsightStatus>("hidden");
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingInsightExitRef = useRef(false);
  const composio = useComposio();

  const clearWaitTimer = useCallback(() => {
    if (waitTimerRef.current) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearWaitTimer, [clearWaitTimer]);

  const finish = useCallback(async () => {
    setFinishing(true);
    setError(null);
    try {
      await onComplete();
      // On success App.tsx flips to AppLayout — this component
      // unmounts before the next render so we don't clear local state.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setFinishing(false);
    }
  }, [onComplete]);

  const handleInsightStatus = useCallback((status: ConnectorInsightStatus, insightKey: string | null) => {
    setInsightStatus(status);
    setActiveInsightKey(insightKey);
    if (status === "hidden") {
      const shouldFinish = awaitingInsightExitRef.current;
      awaitingInsightExitRef.current = false;
      clearWaitTimer();
      if (shouldFinish) {
        void finish();
      }
      return;
    }
    if (status === "ready" || status === "error") {
      if (awaitingInsightExitRef.current) {
        awaitingInsightExitRef.current = false;
        clearWaitTimer();
        setExitStage("summary");
        return;
      }
      setExitStage((current) => (current === "waiting" ? "summary" : current));
    }
  }, [clearWaitTimer, finish]);

  const continueFromInsight = useCallback(() => {
    void finish();
  }, [finish]);

  const finishOrShowInsight = useCallback(() => {
    setError(null);
    clearWaitTimer();
    if (!activeInsightKey || insightStatus === "hidden") {
      awaitingInsightExitRef.current = false;
      void finish();
      return;
    }

    if (insightStatus === "ready" || insightStatus === "error") {
      awaitingInsightExitRef.current = false;
      setExitStage("summary");
      return;
    }

    awaitingInsightExitRef.current = true;
    waitTimerRef.current = setTimeout(() => {
      setExitStage((current) => (current === "summary" ? current : "waiting"));
    }, INSIGHT_WAIT_GRACE_MS);
  }, [activeInsightKey, clearWaitTimer, finish, insightStatus]);

  const showInsightPage = exitStage === "summary";
  const showWaitingPage = exitStage === "waiting";

  return (
    <div className="relative flex h-full w-full items-stretch justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/30" />
      <div
        className={`relative z-10 flex min-h-0 w-full flex-col px-5 pt-safe-top ${
          showInsightPage ? "max-w-2xl" : "max-w-xl"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col pb-3 pt-6">
          <ConnectorOnboardingInsight
            connections={composio.connections}
            mode={showInsightPage ? "page" : "watcher"}
            onStatusChange={handleInsightStatus}
            onContinue={continueFromInsight}
            continueLabel="Enter PIN AI"
          />

          {showWaitingPage ? (
            <InsightWaitPage />
          ) : !showInsightPage && step === 1 ? (
            <>
              <StepHeader
                step={1}
                title="Connect your data"
                subtitle="Pick the apps PIN AI can read from. We'll summarize the first pull while you keep setting up."
              />
              <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto">
                <DataConnections composio={composio} />
              </div>
            </>
          ) : !showInsightPage && step === 2 ? (
            <>
              <StepHeader
                step={2}
                title="Ambient setup"
                subtitle={
                  isNative
                    ? "Turn on ambient sources and record a short self voice sample. You can change both any time in Control Center."
                    : "Ambient sensors run on the iOS app. You can skip this step here and finish ambient setup later from your phone."
                }
              />
              <div className="scrollbar-hidden min-h-0 flex-1 space-y-3 overflow-y-auto">
                <AmbientSourceControlsPanel />
                <VoiceIdentitySettings />
              </div>
            </>
          ) : !showInsightPage ? (
            <>
              <StepHeader
                step={3}
                title="On-device AI model"
                subtitle={
                  isNative
                    ? "Download Gemma 2B so Ambient can summarize your local context privately on this device."
                    : "Local Ambient summaries run on the iOS app. You can skip this step here and download the model from your phone."
                }
              />
              <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto">
                {isNative ? (
                  <AmbientModelSetupStep />
                ) : (
                  <section className="glass-card-strong p-4 text-[13px] leading-relaxed text-foreground/55">
                    Gemma 2B setup is available in the native app. Continue here and finish setup later from Ambient on your phone.
                  </section>
                )}
              </div>
            </>
          ) : null}
        </div>

        {!showInsightPage && !showWaitingPage && (
          <div className="flex-shrink-0 pb-[max(env(safe-area-inset-bottom,0px),var(--safe-bottom,12px),1.5rem)] pt-3">
            {error && (
              <p className="mb-2 text-right text-[12px] leading-snug text-red-500">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              {step < 3 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setStep((step + 1) as Step)}
                    className="min-h-11 rounded-full px-4 text-[13px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06]"
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep((step + 1) as Step)}
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
                    onClick={() => setStep(2)}
                    disabled={finishing}
                    className="min-h-11 rounded-full px-4 text-[13px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06] disabled:opacity-40"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={finishOrShowInsight}
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
        )}
      </div>
    </div>
  );
}
