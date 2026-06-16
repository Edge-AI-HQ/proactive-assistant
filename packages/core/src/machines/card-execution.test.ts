/**
 * Card-execution 状态机回放测试 —— 用 history page fixtures 锁定
 * chatHistoryToSnapshot 的状态合成全分支与衍生投影（Phase 3 提纯纪律：
 * 先回放测试后搬运；这些行为是 ChatDetailView/CardDrawer 打磨出来的）。
 */
import { describe, expect, test } from "vitest";

import type {
  ConversationHistoryMessage,
  ConversationHistoryPage,
} from "../api/conversation";
import {
  cardSessionKeyFor,
  chatHistoryToSnapshot,
  countProposeActions,
  deriveLastMessagePayload,
} from "./card-execution";

function page(
  messages: ConversationHistoryMessage[],
  opts: Partial<Pick<ConversationHistoryPage, "active" | "awaiting">> = {},
): ConversationHistoryPage {
  return {
    messages,
    nextCursor: null,
    awaiting: opts.awaiting ?? null,
    active: opts.active ?? null,
  };
}

const SESSION = "card-thread-card-1";

function proposeActionMsg(
  id: string,
  args: Record<string, unknown>,
  status: "ok" | "running" = "ok",
): ConversationHistoryMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        toolCallId: `tc-${id}`,
        toolName: "propose_action",
        status,
        args,
      },
    ],
  };
}

function userMsg(id: string, text: string): ConversationHistoryMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

describe("chatHistoryToSnapshot — status synthesis", () => {
  test("empty thread → running (preparing spinner)", () => {
    const snap = chatHistoryToSnapshot(SESSION, page([]));
    expect(snap.status).toBe("running");
    expect(snap.cardId).toBe("card-1");
    expect(snap.metadata.inFlight).toBe(false);
  });

  test("awaiting (HITL pause) overrides rows → needs_input", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([userMsg("1", "go")], {
        awaiting: {
          toolUseId: "t1",
          toolName: "GMAIL_SEND_DRAFT",
          allowedDecisions: ["approve"],
          partialParts: [],
        },
      }),
    );
    expect(snap.status).toBe("needs_input");
    expect(snap.metadata.inFlight).toBe(true);
  });

  test("active in-flight turn overrides last-row reading → running", () => {
    // 没有 active 时这页会读出 needs_input（propose_action 终态）——
    // active 必须压过它，否则回复后会闪回上一个 pause。
    const snap = chatHistoryToSnapshot(
      SESSION,
      page(
        [proposeActionMsg("1", { message: "Draft ready?" })],
        { active: { userTexts: ["yes"], replayFrom: null } },
      ),
    );
    expect(snap.status).toBe("running");
  });

  test("last message is user → running (agent presumably mid-turn)", () => {
    const snap = chatHistoryToSnapshot(SESSION, page([userMsg("1", "do it")]));
    expect(snap.status).toBe("running");
  });

  test("last assistant has running tool → running", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([proposeActionMsg("1", { message: "thinking" }, "running")]),
    );
    expect(snap.status).toBe("running");
  });

  test("trailing propose_action → needs_input with pendingInput + input_required event", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([
        userMsg("1", "go"),
        proposeActionMsg("2", {
          message: "Send this draft?",
          options: ["Send", "Edit"],
          plan: [{ tool: "gmail", summary: "send" }],
        }),
      ]),
    );
    expect(snap.status).toBe("needs_input");
    expect(snap.pendingInput?.message).toBe("Send this draft?");
    expect(snap.pendingInput?.options).toEqual(["Send", "Edit"]);
    expect(snap.events.map((e) => e.type)).toEqual([
      "chat:tool:start",
      "chat:tool:result",
      "input_required",
    ]);
  });

  test("text-only completion → pending_done with summary", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([
        userMsg("1", "go"),
        {
          id: "2",
          role: "assistant",
          parts: [{ type: "text", text: "All done. Sent the email." }],
        },
      ]),
    );
    expect(snap.status).toBe("pending_done");
    expect(snap.result?.summary).toBe("All done. Sent the email.");
  });

  test("trailing errored tool with nothing past it → error", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([
        {
          id: "1",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "python_exec",
              status: "error",
            },
          ],
        },
      ]),
    );
    expect(snap.status).toBe("error");
    expect(snap.errorMessage).toMatch(/failed/);
  });
});

describe("chatHistoryToSnapshot — plan_revisions pairing", () => {
  test("pairs each propose_action with the NEXT user reply, stripping legacy wrapper", () => {
    const legacyWrapped = [
      "<current_feedback_card>",
      JSON.stringify({ card_id: "card-1" }),
      "</current_feedback_card>",
      "",
      "User message:",
      "改成下午发",
    ].join("\n");
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([
        proposeActionMsg("1", { message: "v1?" }),
        userMsg("2", legacyWrapped),
        proposeActionMsg("3", { message: "v2?" }),
      ]),
    );
    const revisions = snap.metadata.plan_revisions as Array<{ reply: string }>;
    expect(revisions).toEqual([{ reply: "改成下午发" }]);
    // 第二个 propose_action 还没有 user 回复 → 不产生 revision，且是当前 pause。
    expect(snap.status).toBe("needs_input");
    expect(snap.pendingInput?.message).toBe("v2?");
  });
});

describe("derived projections", () => {
  test("deriveLastMessagePayload merges audit fields forward across re-drafts", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([
        proposeActionMsg("1", {
          message: "v1",
          plan: [{ tool: "gmail", summary: "send" }],
          risks: ["sends email"],
        }),
        userMsg("2", "tweak it"),
        // Re-draft omits plan/risks（agent 常见行为）——audit 必须前向保留。
        proposeActionMsg("3", { message: "v2" }),
      ]),
    );
    const payload = deriveLastMessagePayload(snap.events);
    expect(payload?.message).toBe("v2");
    expect(payload?.plan).toEqual([{ tool: "gmail", summary: "send" }]);
    expect(payload?.risks).toEqual(["sends email"]);
  });

  test("countProposeActions counts message-kind input_required events", () => {
    const snap = chatHistoryToSnapshot(
      SESSION,
      page([
        proposeActionMsg("1", { message: "v1" }),
        userMsg("2", "again"),
        proposeActionMsg("3", { message: "v2" }),
      ]),
    );
    expect(countProposeActions(snap.events)).toBe(2);
  });
});

describe("cardSessionKeyFor", () => {
  test("prefixes bare card ids and passes through session keys", () => {
    expect(cardSessionKeyFor("card-9")).toBe("card-thread-card-9");
    expect(cardSessionKeyFor("card-thread-card-9")).toBe("card-thread-card-9");
  });
});
