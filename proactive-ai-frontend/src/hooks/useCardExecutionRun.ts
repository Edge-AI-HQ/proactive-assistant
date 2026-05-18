/**
 * Card-execute run hook — chat-stream-backed adapter.
 *
 * On this branch (proactive-ai-v3-UX) the heavy card-execute state
 * machine + /api/card-execution-runs/* endpoints are GONE. Cards now
 * use upstream's `/api/chat-stream/*` pipeline scoped by session_key
 * `card-thread-<card_id>`. The agent (`card_execution.py`) calls the
 * `propose_action` tool to surface chips / drafts / plan to the user,
 * and the user's reply is just a normal HumanMessage on the same
 * chat thread.
 *
 * This file preserves the EXTERNAL shape the legacy ChatDetailView
 * was built against (snapshot.status / pendingInput / result, events
 * log of SSE-shaped envelopes, the 5 action methods) so the rich
 * visual layer keeps working without touching it. Internally:
 *
 *   - Initial load: GET /api/chat-stream/history?sessionKey=...,
 *     fold the merged turn list into a RunSnapshot + a synthetic
 *     events log (chat:tool:start / chat:tool:result / input_required
 *     for every propose_action call).
 *   - Live tail: poll history every 1.5s while status is `running`.
 *     There is no separate /stream endpoint on chat-stream; the live
 *     SSE only arrives when WE POST /send, not for fan-out-spawned
 *     background turns.
 *   - reply / continueWith: POST /api/chat-stream/send with the user
 *     text; drain the SSE response (so the chat worker's
 *     StreamingResponse finishes) and refresh history.
 *   - cancel / confirmDone / retry: no real backend equivalent. We
 *     update local state so the UI animation completes and the user
 *     can navigate; the chat thread itself persists either way.
 *
 * The runId argument the hook accepts is the FE-side identifier the
 * old ChatDetailView used; on this branch we treat it as the
 * `card_id` and derive `session_key = card-thread-<card_id>`. Callers
 * pass the IntentCard's string id verbatim.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { proxyFetch, proxyPost } from "@/lib/api";

// ── Shared event envelope ─────────────────────────────────────────────────

export interface SSEEvent {
  type: string;
  ts?: number;
  traceId?: string;
  data?: Record<string, unknown>;
}

// ── Pending-input payload shapes ─────────────────────────────────────────

export interface ExecutionStep {
  tool: string;
  slug?: string | null;
  risk?: "read" | "safe_write" | "dangerous_write" | "blocked";
  summary: string;
}

export interface ExecuteArtifact {
  kind: "email_draft" | "message" | "doc" | "other";
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface DangerousAction {
  slug: string;
  args_preview: Record<string, unknown>;
  args_hash: string;
  risk_label: string;
}

/** Translated from the `propose_action` tool call's structured args.
 *  `kind: "message"` is kept so ChatDetailView's existing branches
 *  (which were written against the old `send_message` shape) keep
 *  working unchanged. */
export interface PendingInput {
  kind: "message";
  message: string;
  drafts?: ExecuteArtifact[];
  options?: string[] | null;
  plan?: ExecutionStep[];
  dangerous_actions?: DangerousAction[];
  risks?: string[];
}

// ── Snapshot shape ───────────────────────────────────────────────────────

export type RunStatus =
  | "running"
  | "needs_input"
  | "resuming"
  | "pending_done"
  | "done"
  | "error"
  | "cancelled";

export interface SideEffect {
  slug: string;
  args_hash: string;
  output_meta: unknown;
  is_error: boolean;
}

export interface RunResult {
  summary?: string;
  side_effects?: SideEffect[];
}

export interface LastMessagePayload {
  message: string;
  drafts: ExecuteArtifact[];
  options: string[] | null;
  plan: ExecutionStep[];
  dangerous_actions: DangerousAction[];
  risks: string[];
}

function messagePayloadEqual(
  a: LastMessagePayload | null,
  b: LastMessagePayload | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function toMessagePayload(p: PendingInput): LastMessagePayload {
  return {
    message: p.message,
    drafts: p.drafts ?? [],
    options: p.options ?? null,
    plan: p.plan ?? [],
    dangerous_actions: p.dangerous_actions ?? [],
    risks: p.risks ?? [],
  };
}

function mergeAuditFields(
  incoming: LastMessagePayload,
  prev: LastMessagePayload | null,
): LastMessagePayload {
  if (!prev) return incoming;
  const incomingHasAudit =
    incoming.plan.length > 0
    || incoming.dangerous_actions.length > 0
    || incoming.risks.length > 0;
  if (incomingHasAudit) return incoming;
  return {
    ...incoming,
    plan: prev.plan,
    dangerous_actions: prev.dangerous_actions,
    risks: prev.risks,
  };
}

export interface RunSnapshot {
  runId: string;
  id: string;
  pipelineRunId: string | null;
  cardId: string;
  mode: "execute";
  status: RunStatus;
  pendingInput: PendingInput | null;
  result: RunResult | null;
  errorMessage: string | null;
  events: SSEEvent[];
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

// ── chat-stream history → RunSnapshot adapter ────────────────────────────

const CARD_THREAD_PREFIX = "card-thread-";

interface HistoryToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  status: "running" | "ok" | "error";
  meta?: string;
  argsPreview?: string;
  /** Full structured args — present when the backend's
   *  chat/routes/history.py `_safe_args_full` produced it
   *  (JSON-serializable and under the 8 KB cap). */
  args?: unknown;
}

interface HistoryTextPart {
  type: "text";
  text: string;
}

interface HistoryReasoningPart {
  type: "reasoning";
  text: string;
}

type HistoryPart = HistoryTextPart | HistoryReasoningPart | HistoryToolCallPart;

interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  parts: HistoryPart[];
  createdAt?: number;
}

interface HistoryResponse {
  ok: boolean;
  messages: HistoryMessage[];
}

/** Pull the propose_action structured args out of a tool-call part.
 *  Tolerant: when `args` is missing (e.g. the call exceeded the 8 KB
 *  cap), the call is treated as if propose_action's payload were
 *  unavailable and the FE falls back to argsPreview-only rendering. */
function parseProposeAction(part: HistoryToolCallPart): PendingInput | null {
  if (part.toolName !== "propose_action") return null;
  const raw = part.args;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === "string" ? r.message : "";
  if (!message) return null;
  const drafts = Array.isArray(r.drafts)
    ? (r.drafts as ExecuteArtifact[])
    : undefined;
  const options = Array.isArray(r.options)
    ? (r.options as string[])
    : null;
  const plan = Array.isArray(r.plan)
    ? (r.plan as ExecutionStep[])
    : [];
  const dangerous_actions = Array.isArray(r.dangerous_actions)
    ? (r.dangerous_actions as DangerousAction[])
    : [];
  const risks = Array.isArray(r.risks) ? (r.risks as string[]) : [];
  return {
    kind: "message", message, drafts, options, plan, dangerous_actions, risks,
  };
}

/** Walk the chat-stream merged turn list and synthesize the
 *  RunSnapshot shape ChatDetailView expects. Each tool-call becomes
 *  a (chat:tool:start, chat:tool:result?) pair in the events log so
 *  the existing eventsToMessages projection keeps working; each
 *  propose_action additionally emits an input_required event so the
 *  pause-history walker (StaticPauseCard) finds it. */
function chatHistoryToSnapshot(
  sessionKey: string,
  history: HistoryResponse,
): RunSnapshot {
  const events: SSEEvent[] = [];
  const messages = Array.isArray(history.messages) ? history.messages : [];

  let latestProposeAction: PendingInput | null = null;
  let finalText = "";
  let saw_error_part = false;

  for (const m of messages) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const part of parts) {
      if (part.type === "tool-call") {
        events.push({
          type: "chat:tool:start",
          ts: m.createdAt,
          data: {
            toolCallId: part.toolCallId,
            name: part.toolName,
            argsPreview: part.argsPreview ?? "",
            args: part.args,
          },
        });
        if (part.status === "ok" || part.status === "error") {
          if (part.status === "error") saw_error_part = true;
          events.push({
            type: "chat:tool:result",
            ts: m.createdAt,
            data: {
              toolCallId: part.toolCallId,
              isError: part.status === "error",
              meta: part.meta ?? "",
            },
          });
        }
        const proposed = parseProposeAction(part);
        if (proposed) {
          latestProposeAction = proposed;
          events.push({
            type: "input_required",
            ts: m.createdAt,
            data: proposed as unknown as Record<string, unknown>,
          });
        }
      } else if (part.type === "text" && m.role === "assistant") {
        // The agent's prose. Accumulate as the eventual `result`
        // summary; if it sits AFTER all propose_action calls in the
        // last assistant turn, that's the final report.
        finalText += part.text;
      }
    }
  }

  // Status synthesis: look at the LAST assistant turn.
  //   - tool call in flight (status="running") and not yet a
  //     propose_action → status="running"
  //   - propose_action present AND no user reply after it
  //     (i.e. it's the latest assistant turn) → status="needs_input"
  //   - text-only completion (no propose_action) → status="pending_done"
  //   - any chat:tool:result with isError + nothing past it → "error"
  //
  // Implementation: iterate messages newest→oldest. The first
  // assistant message we hit "owns" the status; user messages
  // between agent turns mean the agent moved on.
  let status: RunStatus = "running";
  let result: RunResult | null = null;
  let errorMessage: string | null = null;

  if (messages.length === 0) {
    // Fresh thread (fanout hasn't fired or never reached the worker).
    // Surface as "running" so the FE shows the preparing spinner.
    status = "running";
  } else {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "user") {
      // User just replied; agent is presumably mid-turn (we'll see
      // its assistant reply on the next poll).
      status = "running";
    } else {
      // Assistant message — inspect its parts.
      const parts = Array.isArray(lastMsg.parts) ? lastMsg.parts : [];
      const hasProposeAction = parts.some(
        (p): p is HistoryToolCallPart =>
          p.type === "tool-call" && p.toolName === "propose_action",
      );
      const hasRunningTool = parts.some(
        (p): p is HistoryToolCallPart =>
          p.type === "tool-call" && p.status === "running",
      );
      const hasFinalText = parts.some(
        (p): p is HistoryTextPart => p.type === "text" && Boolean(p.text),
      );
      if (hasRunningTool) {
        status = "running";
      } else if (hasProposeAction && latestProposeAction) {
        status = "needs_input";
      } else if (hasFinalText) {
        status = "pending_done";
        result = { summary: finalText.trim(), side_effects: [] };
      } else if (saw_error_part) {
        status = "error";
        errorMessage = "Agent run failed; see tool errors above.";
      } else {
        status = "running";
      }
    }
  }

  const cardId = sessionKey.startsWith(CARD_THREAD_PREFIX)
    ? sessionKey.slice(CARD_THREAD_PREFIX.length)
    : sessionKey;

  return {
    runId: sessionKey,
    id: sessionKey,
    pipelineRunId: null,
    cardId,
    mode: "execute",
    status,
    pendingInput: status === "needs_input" ? latestProposeAction : null,
    result,
    errorMessage,
    events,
    metadata: {},
    createdAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "error", "cancelled"]);

// ── Internal reducer ─────────────────────────────────────────────────────

interface State {
  snapshot: RunSnapshot | null;
  events: SSEEvent[];
  loading: boolean;
  error: string | null;
}

type Action =
  | { kind: "loading" }
  | { kind: "snapshot"; snapshot: RunSnapshot }
  | { kind: "error"; message: string }
  | { kind: "patch_status"; status: RunStatus }
  | { kind: "reset" };

function reducer(prev: State, a: Action): State {
  switch (a.kind) {
    case "loading":
      return { ...prev, loading: true, error: null };
    case "snapshot":
      return {
        snapshot: a.snapshot,
        events: a.snapshot.events,
        loading: false,
        error: null,
      };
    case "error":
      return { ...prev, loading: false, error: a.message };
    case "patch_status":
      if (!prev.snapshot) return prev;
      return { ...prev, snapshot: { ...prev.snapshot, status: a.status } };
    case "reset":
      return { snapshot: null, events: [], loading: false, error: null };
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────

export interface UseCardExecutionRun {
  snapshot: RunSnapshot | null;
  events: SSEEvent[];
  loading: boolean;
  error: string | null;
  /** POST the user's reply as a HumanMessage on the card's chat
   *  thread. Same channel for chip taps and free-text input. */
  reply: (text: string) => Promise<void>;
  /** Local-only: clear local state and let the parent navigate
   *  away. The chat thread persists on the backend either way; user
   *  can come back via the home card any time. */
  cancel: (reason?: string) => Promise<void>;
  /** Send a "retry" bootstrap message to restart card execution. The
   *  chat thread is reused; we return the same sessionKey so the
   *  parent doesn't have to swap runIds. */
  retry: () => Promise<string>;
  /** Re-fetch chat history (used after a reply / on focus). */
  refresh: () => Promise<void>;
  /** Local-only: mark the run as `done` so the toolbar collapses to
   *  the feedback row. No equivalent backend endpoint on chat-stream;
   *  the upstream "Done" gesture is just a UI confirmation. */
  confirmDone: () => Promise<void>;
  /** Send a "continue with this instruction" message. Same as reply
   *  semantically but used by ContinueReplyBox in pending_done state. */
  continueWith: (reason: string) => Promise<string>;
  /** Latest propose_action payload, with audit fields merged forward
   *  across follow-up calls. */
  lastMessagePayload: LastMessagePayload | null;
  /** How many distinct propose_action tool calls the agent has emitted
   *  on this card-thread so far. Flips "Generated draft" → "Updated
   *  draft v2" and re-expands the draft card on each new version. */
  messageCount: number;
}

const NULL_STATE: State = {
  snapshot: null,
  events: [],
  loading: false,
  error: null,
};

const POLL_INTERVAL_MS = 1500;

function sessionKeyFor(runId: string): string {
  if (runId.startsWith(CARD_THREAD_PREFIX)) return runId;
  return `${CARD_THREAD_PREFIX}${runId}`;
}

/** POST /chat-stream/send to fire a HumanMessage into the given
 *  session. Used both by `reply()` for user-driven turns and by the
 *  empty-thread bootstrap path. The chat-stream send endpoint returns
 *  an SSE response; we drain the body to completion so the chat
 *  worker's StreamingResponse finishes (and the agent's checkpointer
 *  state stabilises) before the caller re-fetches history. */
async function sendBootstrap(sessionKey: string, message: string): Promise<void> {
  const res = await proxyPost(
    "/chat-stream/send",
    { session_key: sessionKey, message },
  );
  if (!res.ok) {
    throw new Error(`chat-stream/send bootstrap failed: ${res.status}`);
  }
  try {
    await res.text();
  } catch {
    // Drain failure — the agent may still persist its turn server-
    // side, but our polling loop will reconcile on the next history
    // fetch. Log only.
    // eslint-disable-next-line no-console -- intentional: drain failures must surface during dev
    console.warn("chat-stream/send bootstrap drain failed");
  }
}

export interface UseCardExecutionRunOptions {
  /** When the chat thread is empty on mount, fire this as the user's
   *  first HumanMessage so the card-execution agent starts working
   *  immediately. Mirrors upstream's CardChat bootstrap mechanism —
   *  the home Drawer's Confirm button passes the card's
   *  primaryAction.label here so the agent treats Approve as
   *  "do this action". The text is sent exactly once per (mount,
   *  empty-thread) pair; subsequent visits to a thread with existing
   *  history skip the bootstrap. */
  bootstrap?: string;
}

export function useCardExecutionRun(
  runId: string | null,
  options: UseCardExecutionRunOptions = {},
): UseCardExecutionRun {
  const { bootstrap } = options;
  const [state, dispatch] = useReducer(reducer, NULL_STATE);
  // Track which session_keys we've already fired a bootstrap into so
  // a parent re-render or a polling tick can't double-send the same
  // initial message. Per-mount Set; resets when the hook unmounts.
  const bootstrappedRef = useRef<Set<string>>(new Set());

  const snapshotRef = useRef<RunSnapshot | null>(state.snapshot);
  useEffect(() => {
    snapshotRef.current = state.snapshot;
  }, [state.snapshot]);

  const [lastMessagePayload, setLastMessagePayload] =
    useState<LastMessagePayload | null>(null);

  useEffect(() => {
    setLastMessagePayload(null);
  }, [runId]);

  // Live path: snapshot.pendingInput changes → cache the propose_action
  // args. Merge audit fields forward so re-drafts (which often omit
  // plan / dangerous_actions / risks) don't blank the home Drawer
  // pre-review view.
  useEffect(() => {
    const p = state.snapshot?.pendingInput;
    if (p && p.kind === "message") {
      setLastMessagePayload((prev) => {
        const incoming = toMessagePayload(p);
        const merged = mergeAuditFields(incoming, prev);
        return messagePayloadEqual(prev, merged) ? prev : merged;
      });
    }
  }, [state.snapshot?.pendingInput]);

  // Hydration path: walk events newest→oldest looking for the most
  // recent propose_action that DID carry audit fields, so the Drawer's
  // pre-review keeps showing plan / dangerous_actions / risks across
  // re-drafts that omitted them.
  useEffect(() => {
    let latest: LastMessagePayload | null = null;
    let audit: Pick<
      LastMessagePayload, "plan" | "dangerous_actions" | "risks"
    > | null = null;
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      if (ev.type !== "input_required") continue;
      const data = ev.data as PendingInput | undefined;
      if (!data || data.kind !== "message") continue;
      const payload = toMessagePayload(data);
      if (latest === null) latest = payload;
      if (
        audit === null
        && (payload.plan.length > 0
          || payload.dangerous_actions.length > 0
          || payload.risks.length > 0)
      ) {
        audit = {
          plan: payload.plan,
          dangerous_actions: payload.dangerous_actions,
          risks: payload.risks,
        };
      }
      if (latest && audit) break;
    }
    if (latest === null) return;
    const merged: LastMessagePayload = audit
      ? { ...latest, ...audit }
      : latest;
    setLastMessagePayload((prev) =>
      messagePayloadEqual(prev, merged) ? prev : merged,
    );
  }, [state.events]);

  const fetchSnapshot = useCallback(
    async (id: string): Promise<RunSnapshot> => {
      const session = sessionKeyFor(id);
      const res = await proxyFetch(
        `/chat-stream/history?sessionKey=${encodeURIComponent(session)}`,
      );
      if (!res.ok) {
        throw new Error(`chat-stream/history failed: ${res.status}`);
      }
      const body = (await res.json()) as HistoryResponse;
      return chatHistoryToSnapshot(session, body);
    },
    [],
  );

  // Mount / runId change: fetch initial snapshot + start a polling
  // loop that keeps the snapshot in sync. We poll only while status
  // is non-terminal AND not needs_input — once the agent paused for
  // user input we don't expect new history until the user replies.
  useEffect(() => {
    if (!runId) {
      dispatch({ kind: "reset" });
      return;
    }
    let abort = false;
    dispatch({ kind: "loading" });

    (async () => {
      while (!abort) {
        try {
          const snap = await fetchSnapshot(runId);
          if (abort) return;
          dispatch({ kind: "snapshot", snapshot: snap });

          // Empty-thread bootstrap: when the parent provided a bootstrap
          // message (typical for the Drawer's Confirm path) AND the
          // chat thread has zero events (no propose_action / no prior
          // user reply), fire the bootstrap exactly once and immediately
          // re-poll. Without this the FE would hang on "preparing the
          // plan…" for any card whose fan-out missed (e.g. transient
          // chat-worker hiccup at generator-completion time).
          const sessionKey = sessionKeyFor(runId);
          if (
            bootstrap
            && snap.events.length === 0
            && !bootstrappedRef.current.has(sessionKey)
          ) {
            bootstrappedRef.current.add(sessionKey);
            try {
              // Fire the bootstrap via the same /chat-stream/send path
              // a user reply uses. We don't await an SSE drain here
              // explicitly — `reply()` already does that internally
              // and then dispatches a fresh snapshot.
              await sendBootstrap(sessionKey, bootstrap);
              // Loop body re-runs immediately so the next iteration
              // picks up the populated history.
              continue;
            } catch (e) {
              // Don't trap the user forever on a failed bootstrap —
              // surface as snapshot error and stop polling so the FE
              // shows whatever upstream's onError handler renders.
              const msg = e instanceof Error ? e.message : String(e);
              dispatch({ kind: "error", message: msg });
              return;
            }
          }

          if (TERMINAL.has(snap.status) || snap.status === "needs_input"
              || snap.status === "pending_done") {
            // Steady state — stop polling. We'll re-fetch on user
            // reply / refresh / confirmDone / continueWith.
            return;
          }
        } catch (e: unknown) {
          if (abort) return;
          const msg = e instanceof Error ? e.message : String(e);
          dispatch({ kind: "error", message: msg });
        }
        // Wait before re-polling. Short interval so the
        // "preparing the plan" UI flips to "needs your input" snappily
        // once fanout's chat worker finishes the first propose_action.
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    })();

    return () => {
      abort = true;
    };
  }, [runId, fetchSnapshot]);

  const reply = useCallback(
    async (text: string) => {
      if (!runId) return;
      const trimmed = text.trim();
      if (!trimmed) throw new Error("reply text must be non-empty");
      const session = sessionKeyFor(runId);
      dispatch({ kind: "patch_status", status: "resuming" });
      // POST /send streams an SSE response. We drain it to completion
      // (so the chat worker isn't aborted mid-turn) but ignore the
      // events — the source of truth for ChatDetailView's render is
      // the history fetch below.
      const res = await proxyPost(
        "/chat-stream/send",
        { session_key: session, message: trimmed },
      );
      if (!res.ok) {
        throw new Error(`chat-stream/send failed: ${res.status}`);
      }
      // Drain the body so the response is fully consumed; without
      // this httpx on the web side may cancel the upstream agent.
      try {
        await res.text();
      } catch {
        // Bubble drain errors to console only; the agent's persisted
        // state will be readable on the next history fetch regardless.
        // eslint-disable-next-line no-console -- intentional: drain failures must surface during dev
        console.warn("chat-stream/send drain failed; refreshing anyway");
      }
      try {
        const snap = await fetchSnapshot(runId);
        dispatch({ kind: "snapshot", snapshot: snap });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ kind: "error", message: msg });
      }
    },
    [runId, fetchSnapshot],
  );

  const cancel = useCallback(
    async (_reason?: string) => {
      // Chat threads persist on the backend; cancel is purely a UI
      // "I'm leaving this view" gesture. We flip local status so the
      // ChatDetailView animation can complete; the caller (parent)
      // then navigates away.
      dispatch({ kind: "patch_status", status: "cancelled" });
    },
    [],
  );

  const retry = useCallback(async (): Promise<string> => {
    if (!runId) throw new Error("retry: no runId");
    // Same thread reused — fire a bootstrap-style "please retry" turn
    // and refresh. The agent re-reads card_context from its system
    // message (already persisted) and starts over.
    await reply("Please retry this card from scratch.");
    return runId;
  }, [runId, reply]);

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const snap = await fetchSnapshot(runId);
      dispatch({ kind: "snapshot", snapshot: snap });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ kind: "error", message: msg });
    }
  }, [runId, fetchSnapshot]);

  const confirmDone = useCallback(async () => {
    // Local-only — chat-stream has no "run finalized" concept. The
    // toolbar reads snapshot.status === "done" to collapse to the
    // feedback row, so a status flip is all we need.
    dispatch({ kind: "patch_status", status: "done" });
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

  const messageCount = useMemo(() => {
    let n = 0;
    for (const ev of state.events) {
      if (ev.type !== "input_required") continue;
      const data = ev.data as { kind?: string } | undefined;
      if (data?.kind === "message") n++;
    }
    return n;
  }, [state.events]);

  return {
    snapshot: state.snapshot,
    events: state.events,
    loading: state.loading,
    error: state.error,
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
