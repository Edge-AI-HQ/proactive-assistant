import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useComposio } from "@pin-ai/state";
import { ConnectorOnboardingInsight, DataConnections, Text } from "@pin-ai/ui-web";
import ZebraBackdrop from "./ZebraBackdrop";

const EASE = [0.32, 0.72, 0, 1] as const;

interface ZebraOnboardingProps {
  /** Stamp settings.onboardingCompletedAt; throws on failure so we can surface a retry. */
  onComplete: () => Promise<void> | void;
}

/**
 * Desktop (zebra) first-run onboarding — the web counterpart of the iOS
 * OnboardingFlow, deliberately reduced to the one step that means anything on
 * a desktop: connecting data sources. Ambient sensors and the on-device model
 * are iOS-only, so we point the user at the phone instead of showing empty
 * placeholder steps.
 *
 * Gated by `settings.onboardingCompletedAt == null` in App.tsx; "Enter PIN AI"
 * stamps that field (via onComplete) and App flips to the shell. The inline
 * ConnectorOnboardingInsight surfaces a short profile preview as soon as the
 * first connector pull lands — same component the iOS flow uses.
 */
export default function ZebraOnboarding({ onComplete }: ZebraOnboardingProps) {
  const composio = useComposio();
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(async () => {
    setFinishing(true);
    setError(null);
    try {
      await onComplete();
      // On success App.tsx flips to the shell — this unmounts before the next
      // render, so we don't reset finishing.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setFinishing(false);
    }
  }, [onComplete]);

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <ZebraBackdrop />

      <div className="relative z-10 flex h-full items-center justify-center px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="glass-card-strong flex max-h-full w-full max-w-xl flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex-shrink-0 px-7 pb-5 pt-7">
            <Text variant="caption" weight="semibold" className="block uppercase tracking-[0.18em] text-foreground/40">
              Welcome to PIN AI
            </Text>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              Connect your data
            </h1>
            <Text variant="bodySm" className="mt-1.5 block leading-relaxed text-foreground/55">
              Pick the apps PIN AI can read from — we'll summarize the first pull right here.
              Ambient sensors and the on-device model live in the iOS app; set those up later from your phone.
            </Text>
          </div>

          {/* Body — connector insight (appears once the first pull lands) + connect matrix */}
          <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-7 pb-2">
            <ConnectorOnboardingInsight connections={composio.connections} mode="inline" />
            <DataConnections composio={composio} />
          </div>

          {/* Footer */}
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-foreground/[0.06] px-7 py-4">
            {error ? (
              <Text variant="label" className="leading-snug text-red-500">
                {error}
              </Text>
            ) : (
              <Text variant="label" className="leading-snug text-foreground/45">
                You can connect more anytime in CONNECT.
              </Text>
            )}
            <button
              type="button"
              onClick={() => void finish()}
              disabled={finishing}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-6 text-bodySm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {finishing ? <Loader2 size={14} className="animate-spin" /> : null}
              Enter PIN AI
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
