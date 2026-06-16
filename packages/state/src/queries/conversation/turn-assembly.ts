/**
 * Turn assembly — the live SSE-streamed assistant turn's builder + its
 * transcript entry, folded from deltas in refs and flushed to React state.
 *
 * Extracted from useConversationRuntime (Phase 2) so the streaming-turn
 * lifecycle is one cohesive, independently-reasoned unit. Behaviour is
 * identical to the previous inline version — the SSE handler (sse-handler.ts)
 * and the connection lifecycle (conversation.ts) drive these via the returned
 * refs + helpers.
 */
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import {
  LiveContentBuilder,
  nextEntryId,
  type ConversationAssistantEntry,
  type ConversationEntry,
} from "@pin-ai/core";

export interface TurnAssembly {
  /** The streaming turn's builder (null between turns). */
  builderRef: MutableRefObject<LiveContentBuilder | null>;
  /** The streaming turn's transcript entry id (the stable "turn-N" list key). */
  turnIdRef: MutableRefObject<string | null>;
  /** Cached index of the turn entry in the transcript (O(1) per-delta flush). */
  turnPosRef: MutableRefObject<number>;
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

export function useTurnAssembly(
  setTranscript: Dispatch<SetStateAction<ConversationEntry[]>>,
): TurnAssembly {
  // The streaming turn currently being assembled from SSE deltas. We keep the
  // builder + its transcript entry id in refs so the SSE loop can fold deltas
  // without re-subscribing, then flush to React state on each change.
  const builderRef = useRef<LiveContentBuilder | null>(null);
  const turnIdRef = useRef<string | null>(null);
  // The send-time optimistic placeholder's turn id while it's still UNCLAIMED
  // (no user-turn frame has adopted it). See createTurnPlaceholder.
  const placeholderTurnIdRef = useRef<string | null>(null);
  /** 当前开放 turn 的 traceId——turn 边界检测用（见 handleEnvelope 头部）。 */
  const turnTraceRef = useRef<string | null>(null);
  // Cached index of the current turn's entry in the transcript array, so a
  // per-delta flush is O(1) instead of scanning the whole transcript every
  // token. Other appends (ticks / user messages) always go to the end and
  // never shift this entry; a transcript trim does, so flushTurn revalidates
  // the cached index and re-finds it on a miss.
  const turnPosRef = useRef(-1);

  // Push the in-progress assistant turn's snapshot into the transcript. If the
  // turn entry doesn't exist yet it's appended; otherwise its parts are
  // replaced in place. `running` controls the shimmer affordance.
  const flushTurn = useCallback(
    (running: boolean) => {
      const builder = builderRef.current;
      const turnId = turnIdRef.current;
      if (!builder || !turnId) return;
      const parts = builder.snapshot();
      setTranscript((prev) => {
        let idx = turnPosRef.current;
        const cached = idx >= 0 && idx < prev.length ? prev[idx] : undefined;
        if (!cached || cached.kind !== "assistant" || cached.id !== turnId) {
          idx = prev.findIndex((e) => e.kind === "assistant" && e.id === turnId);
        }
        if (idx === -1) {
          turnPosRef.current = prev.length;
          return [
            ...prev,
            { kind: "assistant", id: turnId, ts: Date.now(), parts, running },
          ];
        }
        turnPosRef.current = idx;
        const next = prev.slice();
        const existing = next[idx] as ConversationAssistantEntry;
        next[idx] = { ...existing, parts, running };
        return next;
      });
    },
    [setTranscript],
  );

  const ensureTurn = useCallback(() => {
    if (!builderRef.current) builderRef.current = new LiveContentBuilder();
    if (!turnIdRef.current) {
      turnIdRef.current = nextEntryId("turn");
      turnPosRef.current = -1;
    }
  }, []);

  const finalizeTurn = useCallback(() => {
    if (turnIdRef.current && builderRef.current) {
      // If the builder produced no visible parts, drop the empty entry rather
      // than leaving a blank bubble.
      if (builderRef.current.isEmpty()) {
        const turnId = turnIdRef.current;
        setTranscript((prev) =>
          prev.filter((e) => !(e.kind === "assistant" && e.id === turnId)),
        );
      } else {
        flushTurn(false);
      }
    }
    builderRef.current = null;
    turnIdRef.current = null;
    turnPosRef.current = -1;
    placeholderTurnIdRef.current = null;
  }, [flushTurn, setTranscript]);

  // Optimistic turn placeholder: open the assistant entry (whose in-entry
  // "Thinking…" pill shows while parts are empty) the moment the user sends,
  // so the reply slot exists immediately — the send anchor scrolls against it
  // and the pill never pops in later. The real turn's frames continue into
  // the same builder (ensureTurn is idempotent). Skipped when a turn is
  // already mid-stream — that builder isn't ours to reuse.
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
    turnPosRef,
    turnTraceRef,
    placeholderTurnIdRef,
    ensureTurn,
    flushTurn,
    finalizeTurn,
    createTurnPlaceholder,
    dropIdlePlaceholder,
  };
}
