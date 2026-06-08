import { motion } from "framer-motion";
import { Radio } from "lucide-react";
import Sphere3DCards from "@/components/now/Sphere3DCards";
import HomeEmptyState from "@/components/now/HomeEmptyState";
import { CATEGORIES, type Intent } from "@/components/now/card-model";
import type { WeatherData } from "@/hooks/useWeather";
import type { VoicePermissionState } from "@/hooks/useVoicePermission";

interface NowViewProps {
  /** First name (or fallback) rendered in the greeting headline. */
  displayName: string;
  /** Cards projected onto the 3D sphere (real /api/cards → Lovable Intent). */
  sphereCards: Intent[];
  ambientOn: boolean;
  ambientTogglePending: boolean;
  /** Local weather for the ambient subtitle; null while loading / unavailable. */
  weather: WeatherData | null;
  /** True until the first /api/cards fetch resolves. Suppresses the empty
   *  state during load so existing users don't flash the setup checklist. */
  feedLoading: boolean;
  /** Count of ACTIVE connectors — drives the empty-state "Connect" nudge. */
  connectorCount: number;
  /** True once the (configured) connector list has loaded, so 0 connectors
   *  is a real signal and not a pre-load empty array. */
  connectorsKnown: boolean;
  /** OS mic permission — drives the empty-state "Turn on voice" nudge. */
  voiceState: VoicePermissionState;
  /** Opens the Ambient tab (left tap on the ambient card). */
  onOpenAmbient: () => void;
  /** Flips the master ambient switch (right pill). */
  onToggleAmbient: () => void;
  /** Empty-state: request mic (parent falls back to the permissions panel). */
  onEnableVoice: () => void;
  /** Empty-state: open the Connect tab. */
  onConnect: () => void;
  /** Empty-state: open the full Ambient permissions panel. */
  onReviewPermissions: () => void;
  /** Tap on a sphere card, keyed by the card's numeric (djb2) id. The parent
   *  owns the routing (existing run vs detail drawer) since it depends on the
   *  real card list + chat state. */
  onCardTap: (id: number) => void;
}

/**
 * "now" home view — greeting + a prominent Ambient card + the 3D sphere of
 * all cards. Purely presentational: card-tap routing and the ambient toggle
 * action live in the parent (AppLayout) and arrive as callbacks.
 */
export default function NowView({
  displayName,
  sphereCards,
  ambientOn,
  ambientTogglePending,
  weather,
  feedLoading,
  connectorCount,
  connectorsKnown,
  voiceState,
  onOpenAmbient,
  onToggleAmbient,
  onEnableVoice,
  onConnect,
  onReviewPermissions,
  onCardTap,
}: NowViewProps) {
  return (
    <div className="relative flex flex-col h-full">
      {/* Greeting + Ambient (always) + Live (when active) */}
      <div
        className="relative z-20 px-5 pb-3"
        style={{ paddingTop: "var(--constellation-header-top)" }}
      >
        {/* Greeting — generous space, editorial feel */}
        <h2 className="text-[30px] font-semibold tracking-tight text-foreground leading-[1.05]">
          Hi,{" "}
          <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
            {displayName}
          </span>
        </h2>
        <p className="mt-1.5 text-[13px] text-foreground/50 leading-snug">
          Your proactive feed · {sphereCards.length} cards today
        </p>

        {/* Ambient — a prominent card (replaces the old divider + plain text
            row). Left tap opens the Ambient tab; right pill toggles the master
            ambient switch (persisted via useAmbientToggle). When ON the Radio
            icon circle and the toggle pill pulse an emerald "sensing" halo
            (animate-ambient-{icon,toggle}-breathe); when OFF the icon greys. */}
        <div className="mt-4 rounded-2xl bg-foreground/[0.04] border border-foreground/[0.06] shadow-sm px-3 py-2.5 flex items-center gap-3">
          <button
            onClick={onOpenAmbient}
            className="flex items-center gap-3 flex-1 min-w-0 text-left"
            aria-label="Open Ambient"
          >
            <span
              className={`relative shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                ambientOn ? "bg-foreground animate-ambient-icon-breathe" : "bg-foreground/30"
              }`}
            >
              <Radio
                size={14}
                strokeWidth={2}
                className={ambientOn ? "text-background" : "text-background/60"}
              />
              {ambientOn && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div
                className={`text-[14px] font-semibold leading-tight ${
                  ambientOn ? "text-foreground" : "text-foreground/70"
                }`}
              >
                {ambientOn ? "Ambient is on" : "Ambient is off"}
              </div>
              <div className="text-[12px] text-foreground/50 leading-snug truncate mt-0.5">
                {!ambientOn
                  ? "Tap to start sensing context"
                  : weather
                    ? `${weather.city} · ${weather.label} · ${weather.temp}°`
                    : "Quiet ambient — connect sources to start streaming signals"}
              </div>
            </div>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleAmbient();
            }}
            disabled={ambientTogglePending}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-60 disabled:cursor-progress ${
              ambientOn ? "bg-foreground animate-ambient-toggle-breathe" : "bg-foreground/20"
            }`}
            aria-label="Toggle ambient"
            aria-pressed={ambientOn}
            aria-busy={ambientTogglePending}
          >
            <motion.span
              layout
              transition={{ type: "tween", duration: 0.2, ease: "easeInOut" }}
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-background shadow-sm ${
                ambientOn ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Card area — the 3D sphere once cards exist; otherwise empty-state
          guidance (connect data / turn on voice) so the feed isn't blank. */}
      <div className="flex-1 relative overflow-hidden">
        {!feedLoading && sphereCards.length === 0 ? (
          <HomeEmptyState
            connectorCount={connectorCount}
            connectorsKnown={connectorsKnown}
            voiceState={voiceState}
            onEnableVoice={onEnableVoice}
            onConnect={onConnect}
            onReviewPermissions={onReviewPermissions}
          />
        ) : (
          <Sphere3DCards
            cacheKey="bigball2-now-sphere"
            cardWidth={160}
            cardHeight={68}
            items={sphereCards.map((c) => ({
              id: c.id,
              category: c.category,
              title: c.title,
              icon: CATEGORIES[c.category].icon,
              categoryLabel: CATEGORIES[c.category].label,
              complexity: c.complexity,
              status: c.status,
            }))}
            onCardTap={onCardTap}
          />
        )}
      </div>
    </div>
  );
}
