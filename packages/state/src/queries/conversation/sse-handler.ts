/**
 * SSE envelope handler — folds one conversation frame into the reducer.
 * Extracted from useConversationRuntime (Phase 2) as a factory so the 12-case
 * dispatch is one reviewable unit, apart from the connection lifecycle.
 *
 * Step 1b: state transitions now `dispatch` into the core conversationReducer
 * instead of calling setters — same logic, just (state,action)→state. The
 * mutable LiveContentBuilder + turn refs are still driven here (flush dispatches
 * `turn_flush`). Side effects that aren't state — the todo store and the
 * onTurnPersisted/onTurnDone doorbells — stay here, keyed by `threadIdRef`
 * (a stable thread identifier set once on `conversation:hello`, NOT a state
 * mirror).
 */
import type { Dispatch, MutableRefObject } from "react";

import {
  parseToolLinks,
  type ConversationAction,
  type ConversationSseEnvelope,
  type JsonValue,
  type LiveContentBuilder,
} from "@pin-ai/core";

import { finalizePlanTurn, parseTodosFromArgs, setTodos } from "../../stores/todos";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface EnvelopeHandlerDeps {
  // Turn-assembly helpers + refs (from useTurnAssembly).
  ensureTurn: () => void;
  flushTurn: (running: boolean) => void;
  finalizeTurn: () => void;
  builderRef: MutableRefObject<LiveContentBuilder | null>;
  turnIdRef: MutableRefObject<string | null>;
  turnTraceRef: MutableRefObject<string | null>;
  placeholderTurnIdRef: MutableRefObject<string | null>;
  // Stable thread id (set once on hello; the todo store / doorbells key on it).
  threadIdRef: MutableRefObject<string | null>;
  // Doorbell refs (kept as refs so the handler isn't rebuilt on callback id change).
  onTurnPersistedRef: MutableRefObject<((threadId: string) => void) | undefined>;
  onTurnDoneRef: MutableRefObject<(() => void) | undefined>;
  // Reducer dispatch (replaces the old state setters).
  dispatch: Dispatch<ConversationAction>;
}

export function createEnvelopeHandler(
  deps: EnvelopeHandlerDeps,
): (env: ConversationSseEnvelope) => void {
  const {
    ensureTurn,
    flushTurn,
    finalizeTurn,
    builderRef,
    turnIdRef,
    turnTraceRef,
    placeholderTurnIdRef,
    threadIdRef,
    onTurnPersistedRef,
    onTurnDoneRef,
    dispatch,
  } = deps;

  return (env: ConversationSseEnvelope) => {
    const payload = env.data ?? {};
    if (env.type.startsWith("chat:") && env.traceId) {
      // Turn 边界兜底：一个 turn 的所有帧共享 traceId；traceId 变化说明
      // 新 turn 已开流而旧 turn 没收到 chat:done（HITL 暂停期间用户插话
      // → 后端取消旧 run 的场景）。不闭旧 turn 的话 ensureTurn 会把新
      // turn 的内容续进老 entry（渲染在历史中段——"新 thinking 出现在
      // 老回复前面"的真机实测 bug）。旧 turn 的待审批卡随之作废。
      if (
        turnIdRef.current
        && turnTraceRef.current
        && turnTraceRef.current !== env.traceId
      ) {
        finalizeTurn();
        dispatch({ type: "set_awaiting", awaiting: null });
      }
      turnTraceRef.current = env.traceId;
      placeholderTurnIdRef.current = null; // claimed by the user turn
    }
    switch (env.type) {
      case "conversation:hello": {
        // Confirm the server-resolved session id so the browser live view +
        // todo store can be keyed to this thread.
        const tid = str(payload.sessionKey);
        if (tid) {
          threadIdRef.current = tid;
          dispatch({ type: "set_thread", threadId: tid });
        }
        break;
      }
      case "chat:thinking": {
        // Turn open signal — start a fresh assistant turn so the
        // "Thinking…" shimmer shows before the first delta lands.
        ensureTurn();
        flushTurn(true);
        break;
      }
      case "chat:reasoning:delta": {
        const delta = str(payload.delta);
        if (!delta) break;
        ensureTurn();
        builderRef.current!.appendReasoning(delta);
        flushTurn(true);
        break;
      }
      case "chat:delta": {
        const delta = str(payload.delta);
        if (!delta) break;
        ensureTurn();
        builderRef.current!.appendText(delta);
        flushTurn(true);
        break;
      }
      case "chat:tool:start": {
        const toolCallId = str(payload.toolCallId);
        const name = str(payload.name);
        if (!toolCallId || !name) break;
        // write_todos feeds the side-panel plan store (keyed by thread id,
        // scoped to this turn via traceId) — the tool chip still renders too,
        // but the structured plan drives TodoPanel. The backend only streams the
        // orchestrator's own write_todos (subagent plans suppressed at the SSE
        // layer), so no source check is needed here.
        if (name === "write_todos" && threadIdRef.current) {
          const todos = parseTodosFromArgs(payload.args);
          if (todos) setTodos(threadIdRef.current, todos, str(env.traceId));
        }
        // All tools — including notify_user — flow through as tool-call parts,
        // matching the history-replay path (historyAssistantParts maps them the
        // same way). The renderer special-cases notify_user into its own card;
        // plain agent text still arrives via chat:delta.
        ensureTurn();
        builderRef.current!.openToolCall({
          toolCallId,
          toolName: name,
          argsPreview: str(payload.argsPreview) || undefined,
          parentTaskId: str(payload.parentTaskId) || undefined,
          agentName: str(payload.agentName) || undefined,
          input: payload.args as JsonValue | undefined,
        });
        flushTurn(true);
        break;
      }
      case "chat:tool:result": {
        const toolCallId = str(payload.toolCallId);
        if (!toolCallId || !builderRef.current) break;
        builderRef.current.completeToolCall({
          toolCallId,
          isError: Boolean(payload.isError),
          meta: str(payload.meta) || undefined,
          links: parseToolLinks(payload.links),
        });
        flushTurn(true);
        break;
      }
      case "chat:group:title": {
        // Async annotation for a closed work group — backfilled onto the
        // anchor tool-call part (same rule as the backend recorder), so
        // live rendering matches the persisted history.
        const anchor = str(payload.anchorToolCallId);
        const title = str(payload.title);
        if (!anchor || !title || !builderRef.current) break;
        builderRef.current.setGroupTitle(anchor, title);
        flushTurn(true);
        break;
      }
      case "chat:requires_action": {
        // HITL: the turn paused on a side-effect tool. Keep the partial turn
        // visible (flushed running), surface the approval, and clear busy so
        // the composer isn't stuck on Stop while we wait for the human.
        const interruptId = str(payload.interruptId);
        if (!interruptId) break;
        flushTurn(true);
        const rawAllowed = payload.allowedDecisions;
        dispatch({
          type: "set_awaiting",
          awaiting: {
            toolUseId: interruptId,
            toolName: str(payload.toolName) || "tool",
            argsPreview: str(payload.argsPreview) || undefined,
            args:
              payload.args &&
              typeof payload.args === "object" &&
              !Array.isArray(payload.args)
                ? (payload.args as Record<string, unknown>)
                : undefined,
            allowedDecisions: Array.isArray(rawAllowed)
              ? rawAllowed.map((x) => str(x))
              : [],
          },
        });
        dispatch({ type: "set_busy", busy: false });
        // HITL pause settles the turn for the card layer too — the card
        // should flip to needs_input now, not on the next 30s poll.
        onTurnDoneRef.current?.();
        break;
      }
      case "chat:done": {
        finalizeTurn();
        dispatch({ type: "clear_queued_flags" });
        // Retire this turn's plan (turn-scoped todos): the panel shows its
        // done beat and hides; the next turn's write_todos starts fresh.
        if (threadIdRef.current) {
          finalizePlanTurn(threadIdRef.current, str(env.traceId));
          onTurnPersistedRef.current?.(threadIdRef.current);
        }
        // done 也清审批卡：总线上 requires_action 永不被同一暂停 turn 的
        // done 跟随(worker 在暂停帧处提前 return,chat 流剩余帧不上桥),
        // 所以这里清是安全的。覆盖两个多设备缺口:另一台设备 approve 后
        // 的 resume 完成、以及 awaiting 中被取消(service.cancel 补发的
        // 终止帧)——否则本设备的审批卡无限期残留。
        dispatch({ type: "set_awaiting", awaiting: null });
        dispatch({ type: "set_busy", busy: false });
        onTurnDoneRef.current?.();
        break;
      }
      case "chat:persisted": {
        // Backend persisted this turn's assistant message — record the real
        // pai_chat_messages id in `serverId` (NOT `id`) so thumbs / feedback
        // can join on it WITHOUT changing the React list key mid-turn:
        // changing `id` would remount the whole entry subtree = visible
        // flicker + height re-measure. Arrives just after chat:done.
        const mid = str(payload.messageId);
        if (!mid) break;
        if (threadIdRef.current) {
          onTurnPersistedRef.current?.(threadIdRef.current);
        }
        dispatch({ type: "persisted", messageId: mid });
        break;
      }
      case "chat:error": {
        // Surface the error as a finalized assistant text part, then close
        // the turn so the next heartbeat starts clean.
        const errMsg = str(payload.error) || "Proactive agent error";
        ensureTurn();
        builderRef.current!.appendText(`\n\n_Error: ${errMsg}_`);
        finalizeTurn();
        dispatch({ type: "set_busy", busy: false });
        break;
      }
      default:
        break;
    }
  };
}
