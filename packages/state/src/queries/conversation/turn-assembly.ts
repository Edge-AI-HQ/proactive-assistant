/**
 * Turn assembly — the live SSE-streamed assistant turn's builder + its
 * transcript entry, folded from deltas in refs and flushed to the reducer.
 *
 * Extracted from useConversationRuntime (Phase 2) so the streaming-turn
 * lifecycle is one cohesive unit. Step 1b: the mutable builder + turn refs stay
 * here; transcript state lives in the core conversationReducer, so flush no
 * longer calls setTranscript — it dispatches `turn_flush` (the reducer owns the
 * turnPos O(1) cache + in-place/append). Behaviour is identical to the inline
 * version; the SSE handler (sse-handler.ts) and connection lifecycle
 * (conversation.ts) drive these via the returned refs + helpers.
 */
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject } from "react";

import { LiveContentBuilder, nextEntryId, type ConversationAction } from "@pin-ai/core";

export interface TurnAssembly {
  /** The streaming turn's builder (null between turns). */
  builderRef: MutableRefObject<LiveContentBuilder | null>;
  /** The streaming turn's transcript entry id (the stable "turn-N" list key). */
  turnIdRef: MutableRefObject<string | null>;
  /** Open turn's traceId — turn-boundary detection (see the SSE handler). */
  turnTraceRef: MutableRefObject<string | null>;
  /** Send-time optimistic placeholder turn id while still UNCLAIMED. */
  placeholderTurnIdRef: MutableRefObject<string | null>;
  ensureTurn: () => void;
  flushTurn: (running: boolean) => void;
  finalizeTurn: () => void;
  createTurnPlaceholder: () => string | null;
  dropIdlePlaceholder: (placeholderId: string | null) => void;
}

export function useTurnAssembly(dispatch: Dispatch<ConversationAction>): TurnAssembly {
  // The streaming turn currently being assembled from SSE deltas. The builder +
  // its transcript entry id stay in refs so the SSE loop can fold deltas without
  // re-subscribing, then flush to the reducer on each change. (turnPos moved into
  // reducer state — the reducer's turn_flush owns the O(1) cache + revalidation.)
  const builderRef = useRef<LiveContentBuilder | null>(null);
  const turnIdRef = useRef<string | null>(null);
  // The send-time optimistic placeholder's turn id while it's still UNCLAIMED
  // (no user-turn frame has adopted it). See createTurnPlaceholder.
  const placeholderTurnIdRef = useRef<string | null>(null);
  /** 当前开放 turn 的 traceId——turn 边界检测用（见 handleEnvelope 头部）。 */
  const turnTraceRef = useRef<string | null>(null);

  // Push the in-progress assistant turn's snapshot into the transcript. The
  // reducer appends a new turn entry if none exists, else replaces its parts in
  // place (turnPos cache). `running` controls the shimmer affordance. ts is
  // stamped here (reducer is pure) and only used on append.
  const flushTurn = useCallback(
    (running: boolean) => {
      const builder = builderRef.current;
      const turnId = turnIdRef.current;
      if (!builder || !turnId) return;
      dispatch({ type: "turn_flush", turnId, parts: builder.snapshot(), running, ts: Date.now() });
    },
    [dispatch],
  );

  const ensureTurn = useCallback(() => {
    if (!builderRef.current) builderRef.current = new LiveContentBuilder();
    // A fresh turnId makes the next flush's cache check miss (id mismatch) → the
    // reducer findIndex's it (absent) → appends, resetting turnPos itself.
    if (!turnIdRef.current) turnIdRef.current = nextEntryId("turn");
  }, []);

  const finalizeTurn = useCallback(() => {
    const builder = builderRef.current;
    const turnId = turnIdRef.current;
    if (turnId && builder) {
      // No visible parts (silent turn) → drop the empty entry; else flush a
      // final non-running snapshot.
      if (builder.isEmpty()) {
        dispatch({ type: "turn_drop", turnId });
      } else {
        dispatch({ type: "turn_flush", turnId, parts: builder.snapshot(), running: false, ts: Date.now() });
      }
    }
    builderRef.current = null;
    turnIdRef.current = null;
    placeholderTurnIdRef.current = null;
  }, [dispatch]);

  // Optimistic turn placeholder: open the assistant entry (whose in-entry
  // "Thinking…" pill shows while parts are empty) the moment the user sends, so
  // the reply slot exists immediately. The real turn's frames continue into the
  // same builder (ensureTurn is idempotent). Skipped when a turn is already
  // mid-stream — that builder isn't ours to reuse.
  const createTurnPlaceholder = useCallback((): string | null => {
    if (builderRef.current) return null;
    ensureTurn();
    flushTurn(true);
    placeholderTurnIdRef.current = turnIdRef.current;
    return turnIdRef.current;
  }, [ensureTurn, flushTurn]);

  // Drop a still-empty placeholder (send failed / nothing ever streamed into
  // it). Guarded so a real turn that already adopted the builder is untouched.
  const dropIdlePlaceholder = useCallback(
    (placeholderId: string | null) => {
      if (!placeholderId) return;
      if (turnIdRef.current === placeholderId && builderRef.current?.isEmpty()) {
        finalizeTurn();
      }
    },
    [finalizeTurn],
  );

  return {
    builderRef,
    turnIdRef,
    turnTraceRef,
    placeholderTurnIdRef,
    ensureTurn,
    flushTurn,
    finalizeTurn,
    createTurnPlaceholder,
    dropIdlePlaceholder,
  };
}
