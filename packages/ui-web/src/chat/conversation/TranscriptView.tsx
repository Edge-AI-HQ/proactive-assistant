import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type Components } from "react-virtuoso";
import { Loader2, Radio } from "lucide-react";
import { useTranslation } from "react-i18next";
import { findHitlHostId, type ConversationEntry } from "@pin-ai/core";
import { HitlApprovalCard, type HitlRequiresAction } from "./HitlApprovalCard";
import { ShimmerText } from "./ReasoningBlock";
import { type ChatScrollApi } from "./scroll/useChatScroll";
import { Text } from "../../primitives/Text";
import { TranscriptEntry } from "./TranscriptEntry";

export interface TranscriptViewProps {
  ready: boolean;
  transcript: ConversationEntry[];
  busy: boolean;
  hasRunningTurn: boolean;
  /** Scroll policy owner (state machine + commands) — see scroll/useChatScroll. */
  scroll: ChatScrollApi;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  retryMessage: (id: string, text: string) => void;
  onEdit: (text: string) => void;
  onUpdateQueued: (id: string, text: string) => Promise<void>;
  onDeleteQueued: (id: string) => Promise<void>;
  onInterruptQueued: (id: string) => Promise<void>;
  onRegenerate: () => void;
  /** Paused HITL run → render the approval gate inline on the paused turn. */
  awaitingDecision: HitlRequiresAction | null;
  onDecide: (decision: "approve" | "reject", message?: string) => void;
}

/** Variable data for the (identity-stable) Virtuoso Footer, passed via the
 *  `context` prop so changes update props instead of remounting the Footer
 *  subtree — a remount would drop the fallback HitlApprovalCard's local
 *  input state. */
interface TranscriptFooterContext {
  busy: boolean;
  hasRunningTurn: boolean;
  awaitingDecision: HitlRequiresAction | null;
  hitlHostId: string | null;
  onDecide: (decision: "approve" | "reject", message?: string) => void;
  runwayPx: number;
}

/** Footer = the HITL fallback for host-less pauses (a debug-hidden turn never
 *  flushed an entry), the pre-stream "Thinking…" pill (only reachable when a
 *  send couldn't open its optimistic placeholder — a foreign heartbeat turn
 *  held the builder), and the runway spacer the send anchor scrolls against
 *  (see useChatScroll). */
function TranscriptFooter({ context }: { context?: TranscriptFooterContext }) {
  const { t } = useTranslation("common");
  if (!context) return null;
  const { busy, hasRunningTurn, awaitingDecision, hitlHostId, onDecide, runwayPx } = context;
  return (
    <>
      {awaitingDecision && !hitlHostId ? (
        <div className="mb-5 px-4 pt-1">
          <HitlApprovalCard action={awaitingDecision} disabled={busy} onDecide={onDecide} />
        </div>
      ) : null}
      {!awaitingDecision && busy && !hasRunningTurn ? (
        <div className="mb-5 px-4 pt-1">
          <div className="inline-flex items-center -ml-2 rounded-lg px-2 py-1 text-label font-medium text-foreground/65">
            <ShimmerText>{t("status.thinking")}</ShimmerText>
          </div>
        </div>
      ) : null}
      <div style={{ height: runwayPx }} aria-hidden="true" />
    </>
  );
}

const TRANSCRIPT_COMPONENTS: Components<ConversationEntry, TranscriptFooterContext> = {
  Footer: TranscriptFooter,
};

/** Transcript viewport (react-virtuoso). Three render modes share the
 *  flex-1 slot below the header:
 *    - !ready                       → loading placeholder
 *    - ready & transcript empty     → landing (main thread) or radio prompt
 *    - ready & transcript non-empty → virtualized list of TranscriptEntry
 *  Virtuoso is a pure virtualized list here — `followOutput={false}` and all
 *  scrolling (send anchor, follow pin, jump) goes through `scroll`
 *  (useChatScroll), which reads back `atBottomStateChange` /
 *  `totalListHeightChanged` / `scrollerRef`. `startReached` still triggers an
 *  older-page load when the user pulls up, with `firstItemIndex` (managed
 *  below) preserving the visual position when the page prepends. */
export function TranscriptView({
  ready,
  transcript,
  busy,
  hasRunningTurn,
  scroll,
  hasMoreHistory,
  loadMoreHistory,
  sendMessage,
  retryMessage,
  onEdit,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
  onRegenerate,
  awaitingDecision,
  onDecide,
}: TranscriptViewProps) {
  const { t } = useTranslation(["chat", "common"]);
  // `firstItemIndex` is a virtual offset that lets prepended history pages
  // keep their visual position. Start high and decrement by the number of
  // items prepended (detected by head id change + growth; appends and
  // in-place turn updates leave it alone).
  const VIRTUOSO_START_INDEX = 1_000_000_000;
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUOSO_START_INDEX);
  const headIdRef = useRef<string | null>(null);
  const lenRef = useRef(0);
  useLayoutEffect(() => {
    const head = transcript[0]?.id ?? null;
    if (
      headIdRef.current
      && head !== headIdRef.current
      && transcript.length > lenRef.current
    ) {
      const prepended = transcript.length - lenRef.current;
      setFirstItemIndex((prev) => prev - prepended);
    }
    headIdRef.current = head;
    lenRef.current = transcript.length;
  }, [transcript]);

  // The paused HITL turn hosts its approval card inline (right where the
  // stream stopped). Host = the last assistant entry, still running. A turn
  // hidden by the Debug filter never flushed an entry → Footer fallback.
  const hitlHostId = useMemo(
    () => findHitlHostId(transcript, !!awaitingDecision),
    [awaitingDecision, transcript],
  );

  const footerContext = useMemo<TranscriptFooterContext>(
    () => ({
      busy,
      hasRunningTurn,
      awaitingDecision,
      hitlHostId,
      onDecide,
      runwayPx: scroll.runwayPx,
    }),
    [busy, hasRunningTurn, awaitingDecision, hitlHostId, onDecide, scroll.runwayPx],
  );
  const onStartReached = useCallback(() => {
    if (hasMoreHistory) void loadMoreHistory();
  }, [hasMoreHistory, loadMoreHistory]);

  // Identify the latest user / assistant turn so only they show the
  // Edit / Regenerate affordances (matching ConversationView's action-bar gating).
  const { lastUserId, lastAssistantId } = useMemo(() => {
    let u: string | null = null;
    let a: string | null = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i];
      if (!u && e.kind === "user") u = e.id;
      if (!a && e.kind === "assistant") a = e.id;
      if (u && a) break;
    }
    return { lastUserId: u, lastAssistantId: a };
  }, [transcript]);

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-foreground/40" />
          <Text variant="bodySm" className="text-foreground/40">{t("common:status.loading")}</Text>
        </div>
      </div>
    );
  }
  if (transcript.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <Radio size={22} strokeWidth={1.5} className="text-foreground/30" />
          <Text variant="bodySm" className="block text-foreground/45">
            {t("transcript.cardEmptyState")}
          </Text>
        </div>
      </div>
    );
  }
  return (
    <Virtuoso
      ref={scroll.virtuosoRef}
      className="scrollbar-hidden"
      style={{ flex: 1 }}
      data={transcript}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={{ index: transcript.length - 1, align: "end" }}
      computeItemKey={(_index, entry) => entry.id}
      itemContent={(_index, entry) => (
        <div className="px-4" data-entry-id={entry.id}>
          <TranscriptEntry
            entry={entry}
            onReply={sendMessage}
            onRetry={retryMessage}
            onEdit={onEdit}
            onUpdateQueued={onUpdateQueued}
            onDeleteQueued={onDeleteQueued}
            onInterruptQueued={onInterruptQueued}
            onRegenerate={onRegenerate}
            isLastUser={entry.id === lastUserId}
            isLastAssistant={entry.id === lastAssistantId}
            busy={busy}
            hitlAction={entry.id === hitlHostId ? awaitingDecision : null}
            onDecide={onDecide}
          />
        </div>
      )}
      startReached={onStartReached}
      followOutput={false}
      atBottomThreshold={48}
      atBottomStateChange={scroll.handleAtBottomChange}
      totalListHeightChanged={scroll.handleTotalHeightChange}
      scrollerRef={scroll.handleScrollerRef}
      increaseViewportBy={400}
      context={footerContext}
      components={TRANSCRIPT_COMPONENTS}
    />
  );
}
