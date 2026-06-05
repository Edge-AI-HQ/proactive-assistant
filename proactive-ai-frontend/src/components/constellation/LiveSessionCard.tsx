import { AnimatePresence, motion } from "framer-motion";
import { Expand, MapPin, Mic, Radio, X } from "lucide-react";
import type { LiveHistoryTranscript, LiveSession } from "@/services/ambient/live-session";

interface LiveSessionCardProps {
  session: LiveSession | null;
  history?: LiveHistoryTranscript[];
  previewVisibleCount: number;
  variant: "ambient" | "now";
  alwaysVisible?: boolean;
  onFocus?: (session: LiveSession) => void;
  onDismiss?: () => void;
}

export default function LiveSessionCard({
  session,
  history = [],
  previewVisibleCount,
  variant,
  alwaysVisible = false,
  onFocus,
  onDismiss,
}: LiveSessionCardProps) {
  const historyItems = history.slice(0, 5);
  if (!session && !alwaysVisible && historyItems.length === 0) return null;
  const isNow = variant === "now";
  const isIdle = !session;
  const title = session?.title ?? "Live standby";
  const kind = session?.kind ?? "Standby";
  const location = session?.location ?? "Waiting for ambient session";
  const device = session?.device ?? "Ambient sensors";
  const SessionIcon = session?.icon ?? Radio;

  return (
    <motion.div
      key={session?.title ?? "live-standby"}
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      transition={{ duration: 0.4 }}
      className={`${isNow ? "mb-4" : "mb-5"} rounded-2xl overflow-hidden relative`}
      style={{
        background: isIdle
          ? "linear-gradient(135deg, hsl(0 0% 100% / 0.42), hsl(0 0% 100% / 0.24))"
          : "linear-gradient(135deg, hsl(304 75% 63% / 0.12) 0%, hsl(304 75% 63% / 0.08) 100%)",
        border: isIdle
          ? "1px solid hsl(0 0% 100% / 0.46)"
          : "1px solid hsl(304 75% 63% / 0.30)",
        boxShadow: isIdle ? undefined : "0 8px 32px hsl(304 75% 63% / 0.15)",
      }}
    >
      <div className={`px-3.5 py-2 flex items-center justify-between border-b ${
        isIdle
          ? "border-foreground/[0.08] bg-foreground/[0.03]"
          : "border-[hsl(304_75%_63%/0.18)] bg-[hsl(304_75%_63%/0.06)]"
      }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="relative flex w-2 h-2 shrink-0">
            {!isIdle && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[hsl(304_75%_63%)] opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${isIdle ? "bg-foreground/35" : "bg-[hsl(304_75%_63%)]"}`} />
          </span>
          <span className={`text-[10px] font-bold uppercase tracking-[0.16em] truncate ${isIdle ? "text-foreground/50" : "text-[hsl(304_75%_42%)]"}`}>
            Live · {kind}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {session && onFocus && (
            <button
              onClick={() => onFocus(session)}
              className="h-9 px-3.5 rounded-full flex items-center gap-1.5 text-[12px] font-semibold text-[hsl(304_75%_32%)] hover:text-[hsl(304_75%_22%)] bg-[hsl(304_75%_63%/0.16)] hover:bg-[hsl(304_75%_63%/0.26)] border border-[hsl(304_75%_63%/0.35)] active:scale-[0.97] transition-all shadow-sm"
              aria-label="Open fullscreen session"
              title="Focus mode"
            >
              <Expand size={14} strokeWidth={2.4} />
              <span>Focus</span>
            </button>
          )}
          {!isNow && onDismiss && (
            <button
              onClick={onDismiss}
              className="w-9 h-9 rounded-full flex items-center justify-center text-foreground/70 hover:text-foreground bg-foreground/[0.05] hover:bg-foreground/[0.12] border border-foreground/[0.10] active:scale-[0.97] transition-all"
              aria-label="End session"
            >
              <X size={17} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>

      <div className="px-3 pt-3 pb-2 flex items-center gap-2.5">
        <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] border border-foreground/[0.08] flex items-center justify-center text-foreground shrink-0">
          <SessionIcon size={17} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-foreground leading-snug truncate">
            {title}
          </p>
          <p className="text-[11px] text-foreground/55 mt-0.5 flex items-center gap-1 truncate">
            <MapPin size={10} className="shrink-0" />
            <span className="truncate">{location}</span>
            <span className="text-foreground/30">·</span>
            <span className="truncate">{device}</span>
          </p>
        </div>
      </div>

      {session && session.signals.length > 0 && (
        <div data-testid="live-session-signals" className="px-4 pb-2 flex flex-wrap gap-1.5">
          {session.signals.slice(0, 5).map((signal) => (
            <span
              key={signal}
              className="inline-flex max-w-full items-center rounded-full bg-foreground/[0.05] border border-foreground/[0.08] px-2 py-0.5 text-[10px] font-medium text-foreground/60 whitespace-nowrap"
            >
              {signal}
            </span>
          ))}
        </div>
      )}

      {session ? (
        <div className="px-4 pb-3.5">
          <div className="h-[126px] overflow-hidden relative">
            <AnimatePresence initial={false} mode="popLayout">
              {session.assists
                .slice(0, previewVisibleCount)
                .slice(-3)
                .reverse()
                .map((a, idx) => {
                  const ageOpacity = idx === 0 ? 1 : idx === 1 ? 0.7 : 0.42;
                  const isNewest = idx === 0;
                  return (
                    <motion.div
                      key={a.time + a.text}
                      layout
                      initial={{ opacity: 0, y: -18, filter: "blur(6px)", scale: 0.97 }}
                      animate={{ opacity: ageOpacity, y: 0, filter: "blur(0px)", scale: 1 }}
                      exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                      transition={{
                        opacity: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
                        y: { type: "spring", stiffness: 320, damping: 30, mass: 0.7 },
                        filter: { duration: 0.4, ease: "easeOut" },
                        scale: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
                        layout: { type: "spring", stiffness: 320, damping: 32, mass: 0.7 },
                      }}
                      className="flex gap-2.5 py-1"
                    >
                      <span
                        className={`text-[9px] font-mono pt-0.5 w-10 shrink-0 tabular-nums transition-colors duration-500 ${
                          isNewest ? "text-[hsl(304_75%_45%)]" : "text-foreground/35"
                        }`}
                      >
                        {a.time}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-[12.5px] leading-snug ${
                            a.kind === "action"
                              ? "text-foreground font-medium"
                              : a.kind === "assist"
                                ? "text-foreground/85"
                                : "text-foreground/65"
                          }`}
                        >
                          {a.kind === "action" && (
                            <span className="inline-block mr-1.5 px-1.5 py-0 rounded text-[9px] font-bold uppercase tracking-wider bg-[hsl(304_75%_63%)] text-white align-middle">
                              Action
                            </span>
                          )}
                          {a.text}
                        </p>
                      </div>
                    </motion.div>
                  );
                })}
            </AnimatePresence>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4">
          <div className="rounded-xl border border-dashed border-foreground/15 bg-foreground/[0.03] px-3 py-3 flex items-center gap-2.5">
            <Mic size={14} className="text-foreground/45 shrink-0" />
            <p className="text-[12.5px] leading-snug text-foreground/55">
              No active live session yet. When Ambient captures a real-world session, it will appear here automatically.
            </p>
          </div>
        </div>
      )}

      {historyItems.length > 0 && (
        <div className="border-t border-foreground/[0.08] px-4 py-3 bg-white/[0.18]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-foreground/45">
              Earlier
            </span>
            <span className="text-[10px] text-foreground/35 tabular-nums">
              {historyItems.length}
            </span>
          </div>
          <div className="space-y-2">
            {historyItems.map((item) => (
              <div key={item.id} className="flex gap-2.5">
                <span className="w-14 shrink-0 pt-0.5 font-mono text-[9px] tabular-nums text-foreground/35">
                  {formatHistoryTime(item.occurredAt)}
                </span>
                <p className="min-w-0 flex-1 text-[12px] leading-snug text-foreground/62">
                  {item.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function formatHistoryTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return "Earlier";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
