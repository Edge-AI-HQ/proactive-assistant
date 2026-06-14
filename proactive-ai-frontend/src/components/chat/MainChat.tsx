import { useCallback, useEffect, useState } from "react";
import { conversationInit } from "@pin-ai/core";
import ConversationView from "./conversation/ConversationView";
import MinimalistLanding from "./conversation/MinimalistLanding";

interface MainChatProps {
  onBack: () => void;
  /** Set when main chat is opened FROM a specific card (give feedback on that
   *  card). Carried on the opening turn so the backend injects it as
   *  <card_context>. Undefined for the normal "Ask PIN AI" entry. */
  cardContext?: Record<string, unknown>;
}

type ViewMode = "landing" | "conversation";

/**
 * Main-Chat router — RC-5: the conversation surface is now the unified
 * `ConversationView` (actor-kernel push UI), keyed by the user's main-chat
 * singleton thread. The MinimalistLanding orb stays the empty-state entry;
 * sending from it transitions into the conversation (carried as `bootstrap`,
 * which ConversationView auto-fires once the thread is ready). Replaces the
 * old conversation runtime path.
 *
 * The thread is a singleton per user (migration 053) — history accumulates and
 * is never split. Both surfaces stay mounted (CSS toggle) so the in-flight
 * stream survives the landing → conversation transition.
 */
export default function MainChat({ onBack, cardContext }: MainChatProps) {
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(cardContext ? "conversation" : "landing");
  const [bootstrap, setBootstrap] = useState<string | undefined>(undefined);

  // Resolve the user's singleton main thread once on mount. A thread that
  // already has history lands directly in the conversation; a fresh thread
  // shows the orb landing (the empty-state entry).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await conversationInit({ kind: "main" });
        if (cancelled) return;
        setSessionKey(r.sessionKey);
        if (r.existing && !cardContext) setView("conversation");
      } catch {
        // Transient — the caller's ASK PIN AI button retries by reopening.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardContext]);

  const handleSubmitFromLanding = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBootstrap(trimmed);
    setView("conversation");
  }, []);

  const cardTitle = typeof cardContext?.title === "string" ? cardContext.title : undefined;

  // Brief transparent placeholder while the singleton key resolves (O(1)
  // latest_id lookup, typically <100ms); the parent's fade-in covers the gap.
  if (sessionKey === null) return <div className="absolute inset-0" aria-hidden />;

  return (
    <>
      <div
        className="absolute inset-0"
        style={{ display: view === "landing" ? "block" : "none" }}
        aria-hidden={view !== "landing"}
      >
        <MinimalistLanding onBack={onBack} onSubmit={handleSubmitFromLanding} disabled={false} />
      </div>
      <div
        className="absolute inset-0"
        style={{ display: view === "conversation" ? "block" : "none" }}
        aria-hidden={view !== "conversation"}
      >
        <ConversationView
          session={sessionKey}
          cardContext={cardContext}
          bootstrap={bootstrap}
          onBack={onBack}
          placeholder={
            cardContext ? "Tell PIN AI what to change about this card…" : undefined
          }
          headerSlot={
            cardContext ? (
              <div className="px-4 pt-1 pb-2">
                <div className="rounded-2xl border border-foreground/[0.06] bg-white/45 px-3 py-2 text-label leading-snug text-foreground/60 backdrop-blur-xl">
                  <span className="font-semibold text-foreground/75">
                    Feedback on this card
                  </span>
                  {cardTitle ? <span> · {cardTitle}</span> : null}
                </div>
              </div>
            ) : undefined
          }
        />
      </div>
    </>
  );
}
