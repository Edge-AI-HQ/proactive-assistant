import { useCallback, useEffect, useState } from "react";
import { proxyPost } from "@/lib/api";
import { useProactiveChatRuntime } from "./chat/useProactiveChatRuntime";
import MainChatView from "./main-chat/MainChatView";
import MinimalistLanding from "./main-chat/MinimalistLanding";

interface MainChatProps {
  onBack: () => void;
  /** Set when main chat is opened FROM a specific card (give feedback on
   *  that card). Carried on the opening turn so the backend injects it as
   *  <card_context> and any preference the agent writes records the card
   *  as evidence. Undefined for the normal "Ask PIN AI" entry. */
  cardContext?: Record<string, unknown>;
}

type ViewMode = "landing" | "conversation";

/**
 * Main-Chat router. Two views over the user's singleton main thread:
 *
 *   - MinimalistLanding (sphere + greeting + chips + composer)
 *   - MainChatView (the conversation transcript)
 *
 * Landing is always the entry. Tapping a chip / sending from the
 * composer transitions into the conversation; backing out from the
 * conversation closes Main Chat and returns to the app's Now surface.
 * The thread is a singleton per user (enforced server-side, see
 * migration 053) — conversation history accumulates and is never split
 * or rotated.
 *
 * Both views stay mounted while sessionKey is known; visibility is
 * toggled via CSS so the in-flight SSE survives the landing →
 * conversation transition.
 */
export default function MainChat({
  onBack,
  cardContext,
}: MainChatProps) {
  const [sessionKey, setSessionKey] = useState<string | null>(null);

  // Fetch the user's main thread once on mount. Backend returns the
  // singleton — created lazily if the user has none yet.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await proxyPost("/chat-stream/init", {});
        if (!res.ok) return;
        const data = (await res.json()) as { sessionKey?: string };
        if (!cancelled && data.sessionKey) {
          setSessionKey(data.sessionKey);
        }
      } catch {
        // Transient — the next mount retries. Caller (ConstellationLayout)
        // owns retry-by-reopen via the ASK PIN AI button.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Brief blank while /init resolves (typically <200ms). The parent
  // wrap has its own fade-in transition, so the user mostly sees that
  // animation cover this gap.
  if (sessionKey === null) return null;
  return (
    <MainChatScope
      sessionKey={sessionKey}
      onBack={onBack}
      cardContext={cardContext}
    />
  );
}

/**
 * Holds the assistant-ui runtime + view toggle once sessionKey is known.
 * Split out so the hook is only called with a real key (no placeholder
 * runtime). Both Landing and MainChatView share this runtime so the
 * Landing's submit can append directly into the same thread without
 * any bootstrap-message indirection.
 */
function MainChatScope({
  sessionKey,
  onBack,
  cardContext,
}: {
  sessionKey: string;
  onBack: () => void;
  cardContext?: Record<string, unknown>;
}) {
  const { runtime, historyLoaded, hasHistory } = useProactiveChatRuntime({
    sessionKey,
    cardContext,
  });
  const [view, setView] = useState<ViewMode>(cardContext ? "conversation" : "landing");
  const cardTitle = typeof cardContext?.title === "string" ? cardContext.title : undefined;

  // Re-entering a thread that already has history should land directly in the
  // conversation, not on the orb landing. The orb is the empty-state surface
  // for a fresh thread; once history loads we skip past it.
  useEffect(() => {
    if (hasHistory) setView("conversation");
  }, [hasHistory]);

  const handleSubmitFromLanding = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setView("conversation");
      void runtime.thread.append({
        role: "user",
        content: [{ type: "text", text: trimmed }],
      });
    },
    [runtime],
  );

  const handleConversationBack = useCallback(() => {
    onBack();
  }, [onBack]);

  return (
    <>
      <div
        className="absolute inset-0"
        style={{ display: view === "landing" ? "block" : "none" }}
        aria-hidden={view !== "landing"}
      >
        <MinimalistLanding
          onBack={onBack}
          onSubmit={handleSubmitFromLanding}
          disabled={!historyLoaded}
        />
      </div>
      <div
        className="absolute inset-0"
        style={{ display: view === "conversation" ? "block" : "none" }}
        aria-hidden={view !== "conversation"}
      >
        <MainChatView
          sessionKey={sessionKey}
          runtime={runtime}
          historyLoaded={historyLoaded}
          onBack={handleConversationBack}
          inputPlaceholder={
            cardContext ? "Tell PIN AI what to change about this card…" : undefined
          }
          headerSlot={
            cardContext ? (
              <div className="px-4 pt-1 pb-2">
                <div className="rounded-2xl border border-foreground/[0.06] bg-white/45 px-3 py-2 text-[12px] leading-snug text-foreground/60 backdrop-blur-xl">
                  <span className="font-semibold text-foreground/75">
                    Feedback on this card
                  </span>
                  {cardTitle ? <span> · {cardTitle}</span> : null}
                </div>
              </div>
            ) : null
          }
        />
      </div>
    </>
  );
}
