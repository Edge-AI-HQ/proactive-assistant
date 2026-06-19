/**
 * conversationReducer 回放测试 —— 锁流式状态机的纯转换：turn flush 的 turnPos
 * 缓存/原地更新、乐观 user 的 queued 判定（取代旧 busyRef/awaitingRef 镜像）、
 * persisted 落 serverId 而不改 id（无 remount flicker）、resync 三段合并委派、
 * 排队气泡维护。
 */
import { describe, expect, test } from "vitest";

import {
  conversationReducer,
  initConversationState,
  type ConversationEntry,
  type ConversationUserEntry,
} from "./conversation";
import type { ConversationContentPart } from "./tool-steps";

const textPart = (text: string): ConversationContentPart => ({ type: "text", text });

describe("conversationReducer", () => {
  test("turn_flush appends a new assistant turn, then updates it in place (ts preserved)", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "turn_flush", turnId: "turn-1", parts: [], running: true, ts: 100 });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ kind: "assistant", id: "turn-1", running: true, ts: 100 });
    expect(s.turnPos).toBe(0);
    s = conversationReducer(s, { type: "turn_flush", turnId: "turn-1", parts: [textPart("hi")], running: false, ts: 999 });
    expect(s.transcript).toHaveLength(1);
    expect((s.transcript[0] as { parts: ConversationContentPart[] }).parts).toEqual([textPart("hi")]);
    expect(s.transcript[0].ts).toBe(100); // append 时的 ts，更新不覆盖
    expect(s.transcript[0].kind === "assistant" && s.transcript[0].running).toBe(false);
  });

  test("turn_drop removes the empty turn entry and resets turnPos", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "turn_flush", turnId: "turn-1", parts: [], running: true, ts: 1 });
    s = conversationReducer(s, { type: "turn_drop", turnId: "turn-1" });
    expect(s.transcript).toHaveLength(0);
    expect(s.turnPos).toBe(-1);
  });

  test("optimistic_user marks queued iff busy", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "optimistic_user", id: "u1", text: "first", ts: 1 });
    expect((s.transcript[0] as ConversationUserEntry).queued).toBeUndefined();
    s = conversationReducer(s, { type: "set_busy", busy: true });
    s = conversationReducer(s, { type: "optimistic_user", id: "u2", text: "second", ts: 2 });
    expect((s.transcript[1] as ConversationUserEntry).queued).toBe(true);
  });

  test("optimistic_user queued when awaitingDecision is set (busy false)", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, {
      type: "set_awaiting",
      awaiting: { toolUseId: "t", toolName: "x", allowedDecisions: [] },
    });
    s = conversationReducer(s, { type: "optimistic_user", id: "u1", text: "x", ts: 1 });
    expect((s.transcript[0] as ConversationUserEntry).queued).toBe(true);
  });

  test("persisted sets serverId on the last assistant; id unchanged; idempotent", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "turn_flush", turnId: "turn-9", parts: [textPart("done")], running: false, ts: 1 });
    s = conversationReducer(s, { type: "persisted", messageId: "12345" });
    const a = s.transcript[0] as { id: string; serverId?: string };
    expect(a.id).toBe("turn-9");
    expect(a.serverId).toBe("12345");
    const before = s.transcript;
    s = conversationReducer(s, { type: "persisted", messageId: "12345" });
    expect(s.transcript).toBe(before); // no-op
  });

  test("clear_queued_flags drops queued on user bubbles (chat:done)", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "set_busy", busy: true });
    s = conversationReducer(s, { type: "optimistic_user", id: "u1", text: "q", ts: 1 });
    expect((s.transcript[0] as ConversationUserEntry).queued).toBe(true);
    s = conversationReducer(s, { type: "clear_queued_flags" });
    expect((s.transcript[0] as ConversationUserEntry).queued).toBe(false);
  });

  test("prepend_history shifts a cached turnPos by the prepended count", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "turn_flush", turnId: "turn-1", parts: [textPart("x")], running: true, ts: 1 });
    expect(s.turnPos).toBe(0);
    const older: ConversationEntry[] = [
      { kind: "user", id: "old-u", ts: 0, text: "older" },
      { kind: "assistant", id: "old-a", ts: 0, parts: [], running: false },
    ];
    s = conversationReducer(s, { type: "prepend_history", entries: older });
    expect(s.transcript.map((e) => e.id)).toEqual(["old-u", "old-a", "turn-1"]);
    expect(s.turnPos).toBe(2);
  });

  test("scalar setters", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "set_connection", connection: "open" });
    s = conversationReducer(s, { type: "set_ready", ready: true });
    s = conversationReducer(s, { type: "set_busy", busy: true });
    s = conversationReducer(s, { type: "set_has_more", hasMoreHistory: true });
    s = conversationReducer(s, { type: "set_thread", threadId: "resolved-1" });
    expect(s).toMatchObject({
      connection: "open", ready: true, busy: true, hasMoreHistory: true, threadId: "resolved-1",
    });
  });

  test("mark_failed / set_user_text / remove_user / insert_user_at (idempotent insert)", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "optimistic_user", id: "u1", text: "v1", ts: 1 });
    s = conversationReducer(s, { type: "mark_failed", id: "u1", failed: true });
    expect((s.transcript[0] as ConversationUserEntry).failed).toBe(true);
    s = conversationReducer(s, { type: "set_user_text", id: "u1", text: "edited" });
    expect((s.transcript[0] as ConversationUserEntry).text).toBe("edited");
    const removed = s.transcript[0] as ConversationUserEntry;
    s = conversationReducer(s, { type: "remove_user", id: "u1" });
    expect(s.transcript).toHaveLength(0);
    s = conversationReducer(s, { type: "insert_user_at", index: 0, entry: removed });
    expect(s.transcript).toHaveLength(1);
    s = conversationReducer(s, { type: "insert_user_at", index: 0, entry: removed });
    expect(s.transcript).toHaveLength(1); // 已存在 → no-op
  });

  test("resync delegates to mergeTranscriptOnResync (dedups local bubble by clientId)", () => {
    let s = initConversationState("main-1");
    s = conversationReducer(s, { type: "optimistic_user", id: "cid-1", text: "hello", ts: 1 });
    const history: ConversationEntry[] = [
      { kind: "user", id: "h1", ts: 0, text: "hello", clientId: "cid-1" },
      { kind: "assistant", id: "a1", ts: 0, parts: [textPart("hi")], running: false },
    ];
    s = conversationReducer(s, { type: "resync", history, serverEntries: [] });
    const users = s.transcript.filter((e) => e.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe("h1");
    expect(s.turnPos).toBe(-1);
  });
});
