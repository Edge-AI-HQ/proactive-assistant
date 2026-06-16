/**
 * Conversation 状态机回放测试 —— 锁 history→entries 转换与 resync 三段
 * 合并算法（carry / identity / text-claim）的全部边界。
 */
import { describe, expect, test } from "vitest";

import type { ConversationHistoryMessage } from "../api/conversation";
import {
  awaitingPartialEntry,
  deriveCardResultMessageId,
  findHitlHostId,
  historyToEntries,
  mergeTranscriptOnResync,
  partsHaveNotifyUser,
  splitQueuedEntries,
  type ConversationEntry,
  type ConversationUserEntry,
} from "./conversation";

function userMsg(id: string, text: string, clientMsgId?: string): ConversationHistoryMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    ...(clientMsgId ? { clientMsgId } : {}),
  };
}

function assistantMsg(id: string, text: string): ConversationHistoryMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function bubble(over: Partial<ConversationUserEntry> & { text: string }): ConversationUserEntry {
  return { kind: "user", id: over.id ?? over.clientId ?? "b", ts: 0, ...over };
}

describe("historyToEntries", () => {
  test("user rows carry the echoed clientMsgId as clientId", () => {
    const [e] = historyToEntries([userMsg("1", "hello", "cid-1")]);
    expect(e.kind).toBe("user");
    expect((e as ConversationUserEntry).clientId).toBe("cid-1");
  });

  test("tool-call parts map status/result/groupTitle through", () => {
    const [e] = historyToEntries([
      {
        id: "1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "notify_user",
            status: "ok",
            groupTitle: "Research",
          },
        ],
      },
    ]);
    expect(e.kind).toBe("assistant");
    const parts = (e as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "notify_user",
      result: { ok: true },
      groupTitle: "Research",
    });
    expect(partsHaveNotifyUser((e as never as { parts: never[] }).parts)).toBe(true);
  });
});

describe("awaitingPartialEntry", () => {
  test("rebuilds the paused turn as a running assistant entry", () => {
    const entry = awaitingPartialEntry({
      toolUseId: "t1",
      toolName: "GMAIL_SEND_DRAFT",
      allowedDecisions: ["approve"],
      partialParts: [{ type: "reasoning", text: "thinking before pause" }],
    });
    expect(entry?.running).toBe(true);
    expect(entry?.id).toBe("partial-t1");
  });

  test("null when nothing streamed before the interrupt", () => {
    expect(
      awaitingPartialEntry({
        toolUseId: "t1",
        toolName: "x",
        allowedDecisions: [],
        partialParts: [],
      }),
    ).toBeNull();
    expect(awaitingPartialEntry(null)).toBeNull();
  });
});

describe("mergeTranscriptOnResync", () => {
  const history = historyToEntries([
    userMsg("h1", "covered", "cid-covered"),
    assistantMsg("h2", "reply"),
  ]);

  test("drops local bubbles whose clientId is echoed by history (incl. stale failed)", () => {
    const prev: ConversationEntry[] = [
      bubble({ text: "covered", clientId: "cid-covered", failed: true }),
      bubble({ text: "pending", clientId: "cid-pending" }),
    ];
    const merged = mergeTranscriptOnResync(prev, history, []);
    const users = merged.filter((e): e is ConversationUserEntry => e.kind === "user");
    expect(users.map((u) => u.clientId)).toEqual(["cid-covered", "cid-pending"]);
    // 第一个来自 history（id=h1），本地 stale failed 气泡被丢弃。
    expect(users[0].id).toBe("h1");
  });

  test("identity pass: pending input matching a local bubble is skipped and clears its failed flag", () => {
    const prev: ConversationEntry[] = [
      bubble({ text: "send me", clientId: "cid-1", failed: true }),
    ];
    const merged = mergeTranscriptOnResync(prev, history, [
      { text: "send me", clientId: "cid-1" },
    ]);
    const users = merged.filter((e): e is ConversationUserEntry => e.kind === "user");
    // history 的 1 条 + carry 的 1 条，没有重复恢复。
    expect(users).toHaveLength(2);
    const carried = users.find((u) => u.clientId === "cid-1");
    expect(carried?.failed).toBe(false);
  });

  test("id-bearing server entry never claims by text — two tabs sending the same text stay distinct", () => {
    const prev: ConversationEntry[] = [
      bubble({ text: "hello", clientId: "tab-a" }),
    ];
    const merged = mergeTranscriptOnResync(prev, history, [
      { text: "hello", clientId: "tab-b" },
    ]);
    const users = merged.filter((e): e is ConversationUserEntry => e.kind === "user");
    // history 1 + 本地 tab-a + 恢复的 tab-b。
    expect(users.map((u) => u.clientId)).toEqual(["cid-covered", "tab-a", "tab-b"]);
  });

  test("text-claim: id-less server entries claim local bubbles by count, not Set", () => {
    const prev: ConversationEntry[] = [
      bubble({ id: "l1", text: "again" }),
      bubble({ id: "l2", text: "again" }),
    ];
    const merged = mergeTranscriptOnResync(prev, history, [
      { text: "again", clientId: null },
      { text: "again", clientId: null },
      { text: "again", clientId: null },
    ]);
    const users = merged.filter(
      (e): e is ConversationUserEntry => e.kind === "user" && e.text === "again",
    );
    // 两个本地气泡被认领 + 第三个 pending 恢复 = 3 条，不多不少。
    expect(users).toHaveLength(3);
  });

  test("failed local bubbles are not claimable by text and survive the merge", () => {
    const prev: ConversationEntry[] = [
      bubble({ id: "l1", text: "retry me", failed: true }),
    ];
    const merged = mergeTranscriptOnResync(prev, history, [
      { text: "retry me", clientId: null },
    ]);
    const users = merged.filter(
      (e): e is ConversationUserEntry => e.kind === "user" && e.text === "retry me",
    );
    // failed 气泡保留 + pending 恢复（不能吃掉 failed 气泡——它的 POST 没落地）。
    expect(users).toHaveLength(2);
    expect(users.some((u) => u.failed)).toBe(true);
  });

  test("pending input with no local bubble (pre-reload send) is restored with identity", () => {
    const merged = mergeTranscriptOnResync([], history, [
      { text: "from before reload", clientId: "cid-x" },
    ]);
    const restored = merged.find(
      (e): e is ConversationUserEntry => e.kind === "user" && e.clientId === "cid-x",
    );
    expect(restored?.text).toBe("from before reload");
  });

  test("preserves queued state from active userEntries across resync", () => {
    const prev: ConversationEntry[] = [
      bubble({ text: "queued follow-up", clientId: "cid-queued", queued: true }),
    ];
    const merged = mergeTranscriptOnResync(prev, history, [
      { text: "queued follow-up", clientId: "cid-queued", queued: true },
      { text: "queued after reload", clientId: "cid-reload", queued: true },
    ]);
    const users = merged.filter((e): e is ConversationUserEntry => e.kind === "user");
    const queued = users.filter((u) => u.queued);
    expect(queued.map((u) => u.clientId)).toEqual(["cid-queued", "cid-reload"]);
  });
});

describe("transcript derivations (split / hitl host / card result)", () => {
  test("splitQueuedEntries separates queued user bubbles from the visible rest", () => {
    const entries: ConversationEntry[] = [
      { kind: "user", id: "u1", ts: 0, text: "sent" },
      { kind: "assistant", id: "a1", ts: 0, parts: [{ type: "text", text: "hi" }], running: false },
      { kind: "user", id: "u2", ts: 0, text: "queued", queued: true },
    ];
    const { visible, queued } = splitQueuedEntries(entries);
    expect(visible.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(queued.map((e) => e.id)).toEqual(["u2"]);
  });

  test("findHitlHostId = last running assistant; null on no-awaiting / settled / none", () => {
    const running: ConversationEntry[] = [
      { kind: "user", id: "u1", ts: 0, text: "x" },
      { kind: "assistant", id: "a1", ts: 0, parts: [], running: true },
    ];
    expect(findHitlHostId(running, true)).toBe("a1");
    expect(findHitlHostId(running, false)).toBeNull(); // no awaiting → no host
    const settled: ConversationEntry[] = [
      { kind: "assistant", id: "a1", ts: 0, parts: [], running: false },
    ];
    expect(findHitlHostId(settled, true)).toBeNull(); // last assistant done → Footer fallback
    expect(findHitlHostId([], true)).toBeNull();
  });

  test("deriveCardResultMessageId: settled assistant w/ text & no proposal → serverId (null pre-persist)", () => {
    expect(
      deriveCardResultMessageId([
        { kind: "assistant", id: "turn-1", ts: 0, parts: [{ type: "text", text: "done" }], running: false, serverId: "123" },
      ]),
    ).toBe("123");
    expect(
      deriveCardResultMessageId([
        { kind: "assistant", id: "turn-1", ts: 0, parts: [{ type: "text", text: "done" }], running: false },
      ]),
    ).toBeNull();
  });

  test("deriveCardResultMessageId → undefined for running / empty / proposal / no-text", () => {
    expect(
      deriveCardResultMessageId([
        { kind: "assistant", id: "a", ts: 0, parts: [{ type: "text", text: "x" }], running: true },
      ]),
    ).toBeUndefined();
    expect(deriveCardResultMessageId([])).toBeUndefined();
    expect(
      deriveCardResultMessageId([
        {
          kind: "assistant", id: "a", ts: 0, running: false, serverId: "1",
          parts: [
            { type: "text", text: "x" },
            { type: "tool-call", toolCallId: "t", toolName: "propose_action", args: {}, argsText: "" },
          ],
        },
      ]),
    ).toBeUndefined();
  });
});
