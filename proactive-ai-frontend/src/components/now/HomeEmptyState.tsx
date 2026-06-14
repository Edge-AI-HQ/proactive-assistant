import { ChevronRight, Mic, Plug } from "lucide-react";
import type { VoicePermissionState } from "@/hooks/useVoicePermission";
import { Text } from "@pin-ai/ui-web";

interface HomeEmptyStateProps {
  /** Count of ACTIVE Composio connectors. 0 → show the "Connect" row. */
  connectorCount: number;
  /** True once the connector list has loaded; until then we don't treat
   *  0 as "no connectors" (avoids nagging already-connected users). */
  connectorsKnown: boolean;
  /** OS mic permission. "missing" → show the "Turn on voice" row (native
   *  only; "unsupported" hides it on web). */
  voiceState: VoicePermissionState;
  /** Request mic inline; parent routes to the permissions panel on deny. */
  onEnableVoice: () => void;
  /** Open the Connect tab. */
  onConnect: () => void;
  /** Open the full Ambient permissions panel (Account → Ambient). */
  onReviewPermissions: () => void;
}

interface ChecklistRowProps {
  icon: typeof Mic;
  title: string;
  subtitle: string;
  onClick: () => void;
}

function ChecklistRow({ icon: Icon, title, subtitle, onClick }: ChecklistRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06]">
        <Icon size={16} strokeWidth={2} className="text-foreground/70" />
      </span>
      <span className="min-w-0 flex-1">
        <Text variant="bodySm" weight="semibold" className="block leading-tight text-foreground">
          {title}
        </Text>
        <Text variant="label" className="mt-0.5 block truncate leading-snug text-foreground/50">
          {subtitle}
        </Text>
      </span>
      <ChevronRight size={16} className="shrink-0 text-foreground/30" />
    </button>
  );
}

/**
 * Home empty-state guidance, rendered in NowView's card area when the
 * proactive feed has zero cards. Two states:
 *
 *   A. Setup incomplete → a short checklist of only the *missing* setup
 *      steps, ordered by importance: voice (mic) first, then connectors.
 *      Each row self-hides once satisfied, so partially-set-up users only
 *      see what's left. A single "Review permissions" link sits below
 *      (native only) instead of enumerating every per-source permission.
 *
 *   B. Setup done, feed still empty → a calm "warming up" message, since
 *      card generation runs async (minutes–hours) and the user has opted
 *      into notifications for the ready signal.
 */
export default function HomeEmptyState({
  connectorCount,
  connectorsKnown,
  voiceState,
  onEnableVoice,
  onConnect,
  onReviewPermissions,
}: HomeEmptyStateProps) {
  const needVoice = voiceState === "missing";
  const needConnect = connectorsKnown && connectorCount === 0;
  // The permissions panel is only meaningful where native ambient sensors
  // exist; on web ("unsupported") the link would lead to an iOS-only page.
  const showPermissionsLink = voiceState !== "unsupported";

  if (!needVoice && !needConnect) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 pb-40 text-center">
        <Text variant="body" weight="semibold" className="block text-foreground/80">
          Your feed is warming up
        </Text>
        <Text variant="bodySm" className="block mt-1.5 max-w-[18rem] leading-relaxed text-foreground/50">
          Generating cards can take a few minutes to a few hours. We'll notify
          you the moment they're ready.
        </Text>
      </div>
    );
  }

  return (
    <div className="px-5 pt-3">
      <Text variant="bodySm" weight="medium" className="block mb-2.5 text-foreground/55">
        Let's get your feed going
      </Text>
      <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-2xl border border-foreground/[0.06] bg-foreground/[0.04] shadow-sm">
        {needVoice && (
          <ChecklistRow
            icon={Mic}
            title="Turn on voice"
            subtitle="Let PIN AI sense your day to suggest cards"
            onClick={onEnableVoice}
          />
        )}
        {needConnect && (
          <ChecklistRow
            icon={Plug}
            title="Connect your apps"
            subtitle="Gmail, Calendar & more — so PIN AI has context"
            onClick={onConnect}
          />
        )}
      </div>
      {showPermissionsLink && (
        <button
          type="button"
          onClick={onReviewPermissions}
          className="mt-3 px-1 text-label text-foreground/45 underline-offset-2 hover:underline"
        >
          Review permissions
        </button>
      )}
    </div>
  );
}
