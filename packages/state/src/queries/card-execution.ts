/**
 * Card-execute run hook — a thin projection over the unified conversation
 * runtime (actor kernel). 与 main chat 共用一套 SSE 数据通路:
 *
 *   - `useConversationRuntime` 拿 transcript（SSE 实时流，取代旧的 1.5s poll
 *     history）+ awaitingDecision；`deriveRunSnapshot`（core 纯函数）把 transcript
 *     投影成 RunSnapshot（drawer 的 plan / drafts / dangerous_actions / result /
 *     plan_revisions）。
 *   - bootstrap（空线程首条消息）委托 runtime 的 `bootstrap` opt（同 once 守卫；
 *     in-flight fanout turn 会作为 running entry 出现在 transcript，runtime 的
 *     `transcript.length > 0` 检查即覆盖旧的 metadata.inFlight 守卫）。
 *   - reply / continueWith → `runtime.sendMessage`；cancel / confirmDone 是本地
 *     UI 终态 flip（chat thread 持久，无后端 finalize 概念）。
 *
 * 对外接口（snapshot / events / loading / error / 6 actions / lastMessagePayload
 * / messageCount）与迁移前一致 → ChatDetailView / ZebraCardDetailPanel /
 * DrawerDetailBody 零改。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildCardThreadTextFeedbackBody,
  cardSessionKeyFor,
  countProposeActions,
  deriveLastMessagePayload,
  deriveRunSnapshot,
  proxyPost,
  type ConversationHistoryPage,
  type LastMessagePayload,
  type RunSnapshot,
  type RunStatus,
  type SSEEvent,
} from "@pin-ai/core";

import { useConversationRuntime } from "./conversation";

export interface UseCardExecutionRun {
  snapshot: RunSnapshot | null;
  events: SSEEvent[];
  loading: boolean;
  error: string | null;
  /** POST the user's reply as a HumanMessage on the card's chat thread. Same
   *  channel for chip taps and free-text input. */
  reply: (text: string) => Promise<void>;
  /** Local-only: flip status to `cancelled` so the drawer can collapse; the
   *  chat thread persists on the backend (resumable via the home card). */
  cancel: (reason?: string) => Promise<void>;
  /** Send a "retry from scratch" message on the same thread. */
  retry: () => Promise<string>;
  /** No-op under the live SSE runtime (kept for interface compatibility). */
  refresh: () => Promise<void>;
  /** Local-only: flip status to `done` so the toolbar collapses to the
   *  feedback row (chat-stream has no "run finalized" concept). */
  confirmDone: () => Promise<void>;
  /** Send a "continue with this instruction" message (pending_done state). */
  continueWith: (reason: string) => Promise<string>;
  /** Latest propose_action payload, audit fields merged forward across
   *  follow-up calls. */
  lastMessagePayload: LastMessagePayload | null;
  /** How many distinct propose_action tool calls the agent has emitted on this
   *  card-thread so far. Flips "Generated draft" → "Updated draft v2". */
  messageCount: number;
}

export interface UseCardExecutionRunOptions {
  /** When the chat thread is empty on mount, fire this as the user's first
   *  HumanMessage so the card-execution agent starts working immediately
   *  (the home Drawer's Confirm path passes the card's primaryAction.label).
   *  Delegated to the conversation runtime's bootstrap (once per empty thread). */
  bootstrap?: string;
  /** Current card payload, sent with the first card-thread turn so the backend
   *  injects it as the thread's <card_context> SystemMessage. */
  cardContext?: Record<string, unknown>;
  /** Sync-B3b：本地同步库读取（注入与 conversation runtime 同构，drawer 首帧秒开）。 */
  localHistory?: (threadId: string, limit: number) => Promise<ConversationHistoryPage | null>;
}

export function useCardExecutionRun(
  runId: string | null,
  options: UseCardExecutionRunOptions = {},
): UseCardExecutionRun {
  const { bootstrap, cardContext, localHistory } = options;
  const session = runId ? cardSessionKeyFor(runId) : "";

  // Single data path: the same SSE runtime main chat uses. Card detail just
  // projects the transcript into a RunSnapshot instead of rendering bubbles.
  const runtime = useConversationRuntime({ session, cardContext, bootstrap, localHistory });

  // done / cancelled are local UI terminal flips — the runtime only derives
  // running / needs_input / pending_done / error (chat thread persists, no
  // backend finalize). Reset whenever the addressed run changes.
  const [localStatus, setLocalStatus] = useState<RunStatus | null>(null);
  useEffect(() => {
    setLocalStatus(null);
  }, [runId]);

  const snapshot = useMemo<RunSnapshot | null>(() => {
    if (!runId) return null;
    const base = deriveRunSnapshot(session, runtime.transcript, {
      awaitingDecision: runtime.awaitingDecision,
      busy: runtime.busy,
    });
    return localStatus ? { ...base, status: localStatus } : base;
  }, [runId, session, runtime.transcript, runtime.awaitingDecision, runtime.busy, localStatus]);

  const events = useMemo(() => snapshot?.events ?? [], [snapshot]);

  // Audit fields are merged forward inside deriveLastMessagePayload (walks the
  // events log newest→oldest), so the home Drawer pre-review keeps plan /
  // dangerous_actions / risks across re-drafts that omit them.
  const lastMessagePayload = useMemo(() => deriveLastMessagePayload(events), [events]);
  const messageCount = useMemo(() => countProposeActions(events), [events]);

  const reply = useCallback(
    async (text: string) => {
      if (!runId) return;
      const trimmed = text.trim();
      if (!trimmed) throw new Error("reply text must be non-empty");
      // Card-thread free text doubles as card feedback (best-effort).
      const feedbackBody = buildCardThreadTextFeedbackBody({
        sessionKey: session,
        userText: trimmed,
        cardContext,
      });
      if (feedbackBody) {
        try {
          await proxyPost("/feedback", feedbackBody);
        } catch {
          // Feedback persistence is best-effort; chat must still proceed.
        }
      }
      // Clear any local terminal flip so the SSE-derived status takes over —
      // the send opens a running placeholder turn → snapshot goes `running`.
      setLocalStatus(null);
      await runtime.sendMessage(trimmed);
    },
    [runId, session, cardContext, runtime],
  );

  const cancel = useCallback(async (_reason?: string) => {
    // Chat threads persist on the backend; cancel is a pure UI "leaving this
    // view" gesture. Flip local status so the drawer animation can complete.
    setLocalStatus("cancelled");
  }, []);

  const retry = useCallback(async (): Promise<string> => {
    if (!runId) throw new Error("retry: no runId");
    // Same thread reused — the agent re-reads the persisted card_context.
    await reply("Please retry this card from scratch.");
    return runId;
  }, [runId, reply]);

  const refresh = useCallback(async () => {
    // The conversation runtime is a live SSE stream — no manual re-fetch.
  }, []);

  const confirmDone = useCallback(async () => {
    setLocalStatus("done");
  }, []);

  const continueWith = useCallback(
    async (reason: string): Promise<string> => {
      if (!runId) throw new Error("continueWith: no runId");
      const trimmed = reason.trim();
      if (!trimmed) throw new Error("continueWith: reason must be non-empty");
      await reply(trimmed);
      return runId;
    },
    [runId, reply],
  );

  return {
    snapshot,
    events,
    loading: !runtime.ready,
    error: null,
    reply,
    cancel,
    retry,
    refresh,
    confirmDone,
    continueWith,
    lastMessagePayload,
    messageCount,
  };
}
