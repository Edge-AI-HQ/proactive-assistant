import { describe, expect, it } from "vitest";
import {
  finalizePlanTurn,
  parseTodosFromArgs,
  setTodos,
  useTodoPlan,
} from "@/components/chat/conversation/todos-store";
import { renderHook, act } from "@testing-library/react";

let seq = 0;
function freshSession(): string {
  seq += 1;
  return `session-${seq}`;
}

describe("todos-store (turn-scoped plans)", () => {
  it("stores a plan with its owning turn", () => {
    const session = freshSession();
    const { result } = renderHook(() => useTodoPlan(session));
    expect(result.current).toBeNull();

    act(() => {
      setTodos(session, [{ content: "step", status: "pending" }], "run-1");
    });

    expect(result.current).toMatchObject({ turnId: "run-1", done: false });
    expect(result.current?.todos).toHaveLength(1);
  });

  it("finalize marks the matching turn done", () => {
    const session = freshSession();
    const { result } = renderHook(() => useTodoPlan(session));
    act(() => {
      setTodos(session, [{ content: "step", status: "completed" }], "run-1");
      finalizePlanTurn(session, "run-1");
    });
    expect(result.current?.done).toBe(true);
  });

  it("finalize for a stale turn does not touch a newer plan", () => {
    const session = freshSession();
    const { result } = renderHook(() => useTodoPlan(session));
    act(() => {
      setTodos(session, [{ content: "a", status: "pending" }], "run-2");
      finalizePlanTurn(session, "run-1");
    });
    expect(result.current?.done).toBe(false);
  });

  it("a new turn's write_todos replaces the previous plan wholesale", () => {
    const session = freshSession();
    const { result } = renderHook(() => useTodoPlan(session));
    act(() => {
      setTodos(session, [{ content: "old", status: "completed" }], "run-1");
      finalizePlanTurn(session, "run-1");
      setTodos(session, [{ content: "new", status: "in_progress" }], "run-2");
    });
    expect(result.current).toMatchObject({ turnId: "run-2", done: false });
    expect(result.current?.todos[0].content).toBe("new");
  });
});

describe("parseTodosFromArgs", () => {
  it("accepts the wire shape and rejects malformed entries", () => {
    expect(
      parseTodosFromArgs({ todos: [{ content: "x", status: "pending" }] }),
    ).toEqual([{ content: "x", status: "pending" }]);
    expect(parseTodosFromArgs({ todos: [{ content: "x", status: "nope" }] })).toBeNull();
    expect(parseTodosFromArgs({})).toBeNull();
  });
});
