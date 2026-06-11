/**
 * Module-level store for `write_todos` plans, keyed by chat sessionKey.
 *
 * A plan is TURN-SCOPED: it belongs to the run (traceId) that wrote it and
 * ends with that turn. `chat:done` finalizes it — the panel shows a brief
 * "done" beat when everything completed, then retires either way; the next
 * turn's first write_todos replaces it. This kills the two long-running-task
 * bugs: stale plans surviving into unrelated conversations, and (with the
 * backend now suppressing subagent write_todos frames) parallel subagents
 * flickering the panel.
 *
 * Module-level (not React context) because:
 *   - Writer (SSE adapter inside useConversationRuntime) and reader
 *     (TodoPanel) live in different parts of the tree; a context provider
 *     would need to wrap both, which means lifting state to ConversationView
 *     and threading it through ChatRuntimeScope just for this.
 *   - The data is per-session, never global; the Map keyed by sessionKey
 *     gives the same isolation a per-thread context would.
 *   - Components subscribe via useSyncExternalStore — the React-idiomatic
 *     pattern for external stores, no extra deps (no Redux/Zustand, per
 *     project convention).
 *
 * Page refresh wipes the store — an in-flight turn's plan re-hydrates via
 * the replayFrom frame replay (the same path as live frames); finished
 * turns' plans are retired by definition and never re-hydrate.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoPlan {
  todos: readonly Todo[];
  /** traceId (run id) of the turn that wrote this plan. */
  turnId: string;
  /** The owning turn finished (chat:done) — the panel retires the plan. */
  done: boolean;
}

const plansBySession = new Map<string, TodoPlan>();
const subscribers = new Map<string, Set<() => void>>();

function notify(sessionKey: string): void {
  const subs = subscribers.get(sessionKey);
  if (subs) {
    for (const fn of subs) fn();
  }
}

export function setTodos(sessionKey: string, todos: Todo[], turnId: string): void {
  plansBySession.set(sessionKey, {
    todos: Object.freeze(todos.slice()),
    turnId,
    done: false,
  });
  notify(sessionKey);
}

/** Mark the turn's plan finished. No-op when a newer turn already owns the
 *  panel (out-of-order done after a fast next send). */
export function finalizePlanTurn(sessionKey: string, turnId: string): void {
  const plan = plansBySession.get(sessionKey);
  if (!plan || plan.done || (turnId && plan.turnId !== turnId)) return;
  plansBySession.set(sessionKey, { ...plan, done: true });
  notify(sessionKey);
}

function subscribe(sessionKey: string, listener: () => void): () => void {
  let subs = subscribers.get(sessionKey);
  if (!subs) {
    subs = new Set();
    subscribers.set(sessionKey, subs);
  }
  subs.add(listener);
  return () => {
    const s = subscribers.get(sessionKey);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) subscribers.delete(sessionKey);
  };
}

function getSnapshot(sessionKey: string): TodoPlan | null {
  return plansBySession.get(sessionKey) ?? null;
}

export function useTodoPlan(sessionKey: string): TodoPlan | null {
  const subscribeFn = useCallback(
    (listener: () => void) => subscribe(sessionKey, listener),
    [sessionKey],
  );
  const getSnapshotFn = useCallback(
    () => getSnapshot(sessionKey),
    [sessionKey],
  );
  return useSyncExternalStore(subscribeFn, getSnapshotFn);
}

/**
 * Type-guard for the raw `args` payload on chat:tool:start when
 * name === "write_todos". Validates shape defensively at the wire boundary
 * so the rest of the frontend trusts the Todo type.
 */
export function parseTodosFromArgs(args: unknown): Todo[] | null {
  if (!args || typeof args !== "object") return null;
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const out: Todo[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") return null;
    const content = (t as { content?: unknown }).content;
    const status = (t as { status?: unknown }).status;
    if (typeof content !== "string") return null;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      return null;
    }
    out.push({ content, status });
  }
  return out;
}
