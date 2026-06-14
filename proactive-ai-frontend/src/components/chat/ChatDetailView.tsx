import { useState, useMemo } from "react";
import { Check, ChevronUp, Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles, X, type LucideIcon } from "lucide-react";
import { DrawerDetailBody } from "@/components/card/CardDrawerBody";
import ConversationView from "@/components/chat/conversation/ConversationView";
import type {
  LastMessagePayload,
  RunSnapshot,
  SideEffect,
} from "@/hooks/useCardExecutionRun";
import { brandSvg, detectToolIcon, type ChatCard, Text } from "@pin-ai/ui-web";
import { buildCardContext, CardContextHeaderSlot, cardThreadSessionKey } from "@pin-ai/ui-web";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";

/**
 * 卡片/聊天展示原语（brandSvg / detectToolIcon / ToolIconBadge / Artifact /
 * ChatCard / matchSideEffect / ArtifactItem）已下沉 @pin-ai/ui-web 的
 * chat-card-presentation（web 介质共享层，apps/web 同源消费）。这里保留
 * re-export，旧 import 路径（@/components/chat/ChatDetailView）不变。
 */
export { brandSvg, detectToolIcon, ToolIconBadge, matchSideEffect, ArtifactItem } from "@pin-ai/ui-web";
export type { ToolIcon, Artifact, ChatCard } from "@pin-ai/ui-web";


interface ChatDetailViewProps {
  card: ChatCard;
  /**
   * Card-execute run id. Optional only to keep alternate Lovable demo
   * layouts (AppLayout / BigBallLayout) type-checking; production
   * always passes a real run id from AppLayout.
   */
  runId?: string;
  onBack: () => void;
  /**
   * Called when the user starts a /retry. Parent should swap runId to the
   * returned new run id. If omitted, retry is hidden.
   */
  onRetry?: (newRunId: string) => void;
  /**
   * Bootstrap HumanMessage to fire automatically if the card's
   * chat-thread is empty on mount. Mirrors upstream's CardChat
   * `bootstrapMessage` semantic: the home Drawer's Confirm button
   * passes the card's `primaryAction.label` here so opening a freshly
   * generated card (whose fan-out missed) still kicks the agent off
   * the same way the user clicking Confirm always has.
   */
  bootstrap?: string;
  /**
   * Legacy: the prior mock-driven implementation accepted "confirm" /
   * "modify" / "done" / "steer" to seed different initial UI. The new
   * SSE-driven flow derives all of that from `runId` snapshot so this
   * prop is accepted (for backward compat with alternate-layout entry
   * points) and ignored.
   */
  mode?: "confirm" | "modify" | "done" | "steer";
  /**
   * Backend feedback hook for the top-toolbar Dismiss button. The hook's
   * `run.cancel()` is local-only (just flips UI state); this callback
   * mirrors the home drawer's Dismiss path so the card POSTs
   * /feedback kind=dismiss, drops out of the sphere, and shows as
   * Dismissed in the TASKS view. Parent wires this to
   * `cardActions.dismiss(realIntentCard)`.
   */
  onDismissBackend?: () => void | Promise<void>;
  /**
   * Backend feedback hook for the top-toolbar Done button. Same shape
   * as `onDismissBackend` — POSTs /feedback kind=card_action
   * action=complete so the card moves from sphere → TASKS as Completed.
   */
  onDoneBackend?: () => boolean | void | Promise<boolean | void>;
  /**
   * Fired on every chat:done (agent turn ended). Parent wires this to the
   * card layer so the sphere/timeline status flips the moment the agent
   * finishes instead of waiting for the next /cards poll.
   */
  onTurnDone?: () => void;
  /**
   * Result-bar Comment hook: persists the user's free-text feedback on this
   * card (POST /feedback kind=text_feedback — learning signal for the next
   * generation run, never messages the agent). Parent wires this to
   * `cardActions.textFeedback(realIntentCard, text)`.
   */
  onCommentBackend?: (text: string) => void | Promise<void>;
}

export default function ChatDetailView({
  card,
  runId,
  onBack,
  bootstrap,
  onTurnDone,
  onDismissBackend,
  onDoneBackend,
  onCommentBackend,
}: ChatDetailViewProps) {
  const [cardDrawerOpen, setCardDrawerOpen] = useState(false);
  const sessionKey = useMemo(
    () => cardThreadSessionKey(card, runId),
    [card, runId],
  );
  const cardContext = useMemo(() => buildCardContext(card), [card]);

  return (
    <>
      <ConversationView
        session={sessionKey}
        cardContext={cardContext}
        bootstrap={bootstrap}
        title={card.title}
        onBack={onBack}
        backIcon="left"
        onTurnDone={onTurnDone}
        cardFeedback={
          onDoneBackend && onCommentBackend
            ? { onDone: onDoneBackend, onComment: onCommentBackend }
            : undefined
        }
        placeholder="Message about this card..."
        headerSlot={
          <CardContextHeaderSlot
            card={card}
            onOpen={() => setCardDrawerOpen(true)}
          />
        }
      />

      <Drawer open={cardDrawerOpen} onOpenChange={setCardDrawerOpen}>
        <DrawerContent
          className="max-h-[85vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{card.title}</DrawerTitle>
            <DrawerDescription>Card detail view</DrawerDescription>
          </DrawerHeader>
          <ChatCardDrawerBody card={card} />
          {/* Dismiss / Done are reachable from EVERY drawer (unified action
              model): both retire the card (negative / positive feedback),
              then close drawer + chat. */}
          {(onDismissBackend || onDoneBackend) && (
            <div className="flex items-center gap-2 px-5 pb-6 pt-1">
              {onDismissBackend && (
                <button
                  type="button"
                  onClick={() => {
                    setCardDrawerOpen(false);
                    void Promise.resolve(onDismissBackend()).finally(() => onBack());
                  }}
                  className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-bodySm font-medium text-foreground/55"
                >
                  <X size={13} strokeWidth={2} /> Dismiss
                </button>
              )}
              {onDoneBackend && (
                <button
                  type="button"
                  onClick={() => {
                    setCardDrawerOpen(false);
                    void Promise.resolve(onDoneBackend()).finally(() => onBack());
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-bodySm font-semibold hover:bg-foreground/85 transition-colors"
                >
                  <Check size={13} strokeWidth={2.5} /> Done
                </button>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}

const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth: { icon: Sprout, label: "Growth" },
  work: { icon: Briefcase, label: "Work" },
  finance: { icon: TrendingUp, label: "Finance" },
  health: { icon: Heart, label: "Health" },
  learn: { icon: BookOpen, label: "Learn" },
  life: { icon: Sparkles, label: "Life" },
};

/* Drawer body — mirrors home CardDrawerContent (no action buttons). The
 * optional `runSnapshot` + `lastMessagePayload` + `sideEffects` let
 * DrawerDetailBody render the LIVE plan + drafts + dangerous_actions +
 * post-execution side-effect badges pulled from the agent's pending_input
 * (and the cached send_message snapshot) rather than the card's static
 * mock. This is the same data the home drawer uses; the chat-side
 * drawer must mirror it so opening the drawer from inside a card never
 * shows a stale view. */
function ChatCardDrawerBody({
  card,
  runSnapshot,
  lastMessagePayload,
  sideEffects = [],
}: {
  card: ChatCard;
  runSnapshot?: RunSnapshot | null;
  lastMessagePayload?: LastMessagePayload | null;
  sideEffects?: SideEffect[];
}) {
  const cat = CATEGORIES[card.category];
  const Icon = cat?.icon || Briefcase;

  return (
    <div className="px-5 pb-5 pt-1.5 overflow-y-auto max-h-[75vh]">
      {/* Category + tag + Quick badge */}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{cat?.label || card.category}</span>
        {card.tag && (
          <Text variant="caption" weight="bold" className="px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
            {card.tag}
          </Text>
        )}
        {card.complexity === "simple" && (
          <span
            className="inline-flex items-center gap-1 text-caption font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: "hsl(var(--primary) / 0.12)", color: "hsl(var(--primary))" }}
            title="Low-risk task — usually safe to approve as-is"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "hsl(var(--primary))" }} />
            Quick approve
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-subheading leading-snug text-foreground mb-1.5 font-semibold">{card.title}</h3>

      {/* Concise "what to do" summary */}
      <Text variant="bodySm" className="block text-foreground/55 leading-snug mb-3">
        {card.detail?.willExecute || card.line1}
      </Text>

      {card.detail && (
        <DrawerDetailBody
          card={card}
          runSnapshot={runSnapshot}
          lastMessagePayload={lastMessagePayload}
          sideEffects={sideEffects}
        />
      )}
    </div>
  );
}
