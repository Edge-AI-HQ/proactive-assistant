/**
 * Module-level store for `write_todos` plans, keyed by chat sessionKey.
 *
 * The chat agent's `write_todos` tool emits a structured `args.todos` array
 * on `chat:tool:start`. We capture it here so MainChatView's TodoPanel can
 * subscribe without prop-drilling through the assistant-ui runtime.
 *
 * Module-level (not React context) because:
 *   - Writer (SSE adapter inside useProactiveChatRuntime) and reader
 *     (TodoPanel) live in different parts of the tree; a context provider
 *     would need to wrap both, which means lifting state to MainChatView
 *     and threading it through ChatRuntimeScope just for this.
 *   - The data is per-session, never global; the Map keyed by sessionKey
 *     gives the same isolation a per-thread context would.
 *   - Components subscribe via useSyncExternalStore — the React-idiomatic
 *     pattern for external stores, no extra deps (no Redux/Zustand, per
 *     project convention).
 *
 * Page refresh wipes the store — todos are not persisted client-side. v1
 * accepts this: the planned "refresh-resume partial results" PR will hydrate
 * todos alongside the rest of the in-flight stream state.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const EMPTY_TODOS: readonly Todo[] = Object.freeze([]);

const todosBySession = new Map<string, readonly Todo[]>();
const subscribers = new Map<string, Set<() => void>>();

export function setTodos(sessionKey: string, todos: Todo[]): void {
  todosBySession.set(sessionKey, Object.freeze(todos.slice()));
  const subs = subscribers.get(sessionKey);
  if (subs) {
    for (const fn of subs) fn();
  }
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

function getSnapshot(sessionKey: string): readonly Todo[] {
  return todosBySession.get(sessionKey) ?? EMPTY_TODOS;
}

export function useTodos(sessionKey: string): readonly Todo[] {
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
