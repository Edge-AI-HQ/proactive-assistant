import { motion } from "framer-motion";
import { Loader2, Radio } from "lucide-react";
import {
  CATEGORIES,
  categoryLabel,
  Sphere3DCards,
  type Intent,
  type WeatherData, Text,
} from "@pin-ai/ui-web";
import { shortcutHint } from "@/lib/platform";

/**
 * Desktop (zebra) NOW view — the iOS Now screen rescaled for a wide canvas.
 * Greeting + ambient pill sit top-left, the 3D card sphere fills the rest,
 * and the swipe-up "Ask PIN AI" hint becomes a centered command bar (⌘K).
 *
 * 数据全部来自真实后端：sphereCards = /api/cards 的投影（Shell 负责），
 * ambient pill = /api/settings 的 ambientSources consent + Open-Meteo 天气。
 */
export default function ZebraNow({
  displayName,
  sphereCards,
  cardsLoading,
  ambientOn,
  ambientBusy,
  onToggleAmbient,
  weather,
  onAskPinAi,
  onCardTap,
}: {
  displayName: string;
  sphereCards: Intent[];
  cardsLoading: boolean;
  ambientOn: boolean;
  ambientBusy: boolean;
  onToggleAmbient: () => void;
  weather: WeatherData | null;
  onAskPinAi: () => void;
  onCardTap: (card: Intent) => void;
}) {
  const subtitle = ambientOn
    ? weather
      ? `${weather.city ? `${weather.city} · ` : ""}${weather.label} · ${weather.temp}°`
      : "Sensing context"
    : "Turn on to start sensing context";

  return (
    // Content column is capped and centered (industry convention) — on ultra-
    // wide windows the sphere stops growing and the ambient background fills
    // the margins; below the cap everything shrinks fluidly with the window.
    <div className="relative flex flex-col h-full w-full max-w-[1160px] mx-auto">
      {/* Greeting + Ambient pill */}
      <div className="relative z-20 px-10 pt-10 pb-2">
        <Text as="h2" variant="display" weight="semibold" className="tracking-tight">
          Hi,{" "}
          <span className="bg-gradient-to-r from-primary to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
            {displayName}
          </span>
        </Text>
        <Text variant="bodySm" className="block mt-1.5 text-foreground/50 leading-snug">
          Your proactive feed · {sphereCards.length} cards today
        </Text>

        <div className="glass-card mt-4 max-w-sm px-3.5 py-3 flex items-center gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0 text-left">
            <span
              className={`relative shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
                ambientOn ? "animate-ambient-icon-breathe" : ""
              }`}
              style={{
                background: ambientOn
                  ? "linear-gradient(135deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.55) 100%)"
                  : "linear-gradient(135deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.15) 100%)",
              }}
            >
              <Radio
                size={15}
                strokeWidth={2}
                className={ambientOn ? "text-white" : "text-white/70"}
              />
              {ambientOn && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
                  style={{
                    background: "linear-gradient(135deg, #34d399 0%, #10b981 100%)",
                    boxShadow: "0 0 0 2px rgba(255,255,255,0.6)",
                  }}
                />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className={`text-body font-semibold leading-tight ${ambientOn ? "text-foreground" : "text-foreground/70"}`}>
                {ambientOn ? "Ambient is on" : "Ambient is off"}
              </div>
              <Text variant="label" className="block text-foreground/50 leading-snug truncate mt-0.5">
                {subtitle}
              </Text>
            </div>
          </div>
          <button
            onClick={onToggleAmbient}
            disabled={ambientBusy}
            className={`relative w-11 h-7 rounded-full shrink-0 transition-colors disabled:opacity-60 ${
              ambientOn ? "animate-ambient-toggle-breathe" : ""
            }`}
            style={{
              background: ambientOn
                ? "linear-gradient(135deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.6) 100%)"
                : "linear-gradient(135deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.1) 100%)",
            }}
            aria-label="Toggle ambient"
          >
            <motion.span
              layout
              transition={{ type: "tween", duration: 0.2, ease: "easeInOut" }}
              className="absolute top-0.5 w-6 h-6 rounded-full"
              style={{
                left: ambientOn ? "20px" : "2px",
                background: "linear-gradient(180deg, #ffffff 0%, #f2f2f7 100%)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.8)",
              }}
            />
          </button>
        </div>
      </div>

      {/* 3D sphere of all cards — drag to rotate; auto-fits the wide canvas */}
      <div className="flex-1 relative overflow-hidden">
        {sphereCards.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="glass-card px-6 py-4 flex items-center gap-2.5">
              {cardsLoading ? (
                <>
                  <Loader2 size={14} className="animate-spin text-foreground/45" />
                  <Text variant="bodySm" className="text-foreground/55">Loading your cards…</Text>
                </>
              ) : (
                <Text variant="bodySm" className="text-foreground/55">
                  No cards yet — they surface here as PIN AI learns your context.
                </Text>
              )}
            </div>
          </div>
        ) : (
          <Sphere3DCards
            cacheKey="zebra-now-sphere"
            cardWidth={160}
            cardHeight={68}
            items={sphereCards.map((c) => ({
              id: c.id,
              category: c.category,
              title: c.title,
              icon: (CATEGORIES[c.category] ?? CATEGORIES.life).icon,
              categoryLabel: categoryLabel(c.category),
              complexity: c.complexity,
              status: c.status,
            }))}
            onCardTap={(id) => {
              const card = sphereCards.find((c) => c.id === id);
              if (card) onCardTap(card);
            }}
          />
        )}
      </div>

      {/* Ask PIN AI — desktop command bar (click or ⌘K) */}
      <div className="shrink-0 pb-8 px-10 flex justify-center">
        <button
          onClick={onAskPinAi}
          className="group w-full max-w-xl flex items-center gap-3 pl-5 pr-3 py-3 rounded-3xl border border-foreground/[0.08] hover:border-foreground/[0.16] transition-colors text-left"
          style={{
            background: "rgba(255,255,255,0.6)",
            backdropFilter: "blur(20px) saturate(1.5)",
            WebkitBackdropFilter: "blur(20px) saturate(1.5)",
            boxShadow: "0 4px 24px hsl(0 0% 0% / 0.04)",
          }}
          aria-label="Ask PIN AI"
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)" }}
          />
          <span className="flex-1 text-body text-foreground/40 group-hover:text-foreground/60 transition-colors">
            Ask PIN AI…
          </span>
          <kbd className="shrink-0 px-2 py-1 rounded-lg bg-foreground/[0.05] border border-foreground/[0.08] text-caption font-medium text-foreground/45 tracking-wide">
            {shortcutHint("K")}
          </kbd>
        </button>
      </div>
    </div>
  );
}
