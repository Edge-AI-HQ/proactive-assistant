/**
 * Card-execution 状态机回放测试 —— 用 transcript fixtures 锁定 deriveRunSnapshot
 * 的状态合成全分支与衍生投影。统一 runtime 后 card detail 与 main chat 共用一份
 * transcript（SSE），snapshot 是其上的纯派生（取代旧的 history-page → snapshot）。
 */
import { describe, expect, test } from "vitest";

import type { ConversationAssistantEntry, ConversationEntry, ConversationUserEntry, HitlRequiresAction } from "./conversation";
import type { JsonValue } from "./tool-steps";
import {
  cardSessionKeyFor,
  countProposeActions,
  deriveLastMessagePayload,
  deriveRunSnapshot,
} from "./card-execution";

const SESSION = "card-thread-card-1";
const NO_CTX = { awaitingDecision: null as HitlRequiresAction | null, busy: false };

function snap(transcript: ConversationEntry[], ctx = NO_CTX) {
  return deriveRunSnapshot(SESSION, transcript, ctx);
}

/** Assistant turn carrying a single propose_action tool-call. `status` is the
 *  content part's args.status; `running` marks the turn still streaming. */
function proposeAction(
  id: string,
  args: Record<string, JsonValue>,
  opts: { status?: "ok" | "running"; running?: boolean } = {},
): ConversationAssistantEntry {
  return {
    kind: "assistant",
    id,
    ts: 0,
    running: opts.running ?? false,
    parts: [
      {
        type: "tool-call",
        toolCallId: `tc-${id}`,
        toolName: "propose_action",
        args: { status: opts.status ?? "ok", input: args },
        argsText: "",
      },
    ],
  };
}

function toolTurn(id: string, toolName: string, status: "ok" | "running" | "error"): ConversationAssistantEntry {
  return {
    kind: "assistant",
    id,
    ts: 0,
    running: false,
    parts: [{ type: "tool-call", toolCallId: `tc-${id}`, toolName, args: { status }, argsText: "" }],
  };
}

function textTurn(id: string, text: string): ConversationAssistantEntry {
  return { kind: "assistant", id, ts: 0, running: false, parts: [{ type: "text", text }] };
}

/** In-flight turn: a still-streaming assistant entry (runtime's live placeholder)
 *  — the transcript-native equivalent of the old history page's `active`. */
function runningTurn(id: string): ConversationAssistantEntry {
  return { kind: "assistant", id, ts: 0, running: true, parts: [] };
}

function userTurn(id: string, text: string): ConversationUserEntry {
  return { kind: "user", id, ts: 0, text };
}

describe("deriveRunSnapshot — status synthesis", () => {
  test("empty thread → running (preparing spinner)", () => {
    const s = snap([]);
    expect(s.status).toBe("running");
    expect(s.cardId).toBe("card-1");
    expect(s.metadata.inFlight).toBe(false);
  });

  test("awaiting (HITL pause) → needs_input", () => {
    const s = snap([userTurn("1", "go")], {
      awaitingDecision: { toolUseId: "t1", toolName: "GMAIL_SEND_DRAFT", allowedDecisions: ["approve"] },
      busy: true,
    });
    expect(s.status).toBe("needs_input");
    expect(s.metadata.inFlight).toBe(true);
  });

  test("in-flight (running trailing assistant) overrides a prior propose_action → running", () => {
    // 没有 in-flight turn 时这页读出 needs_input（propose_action 终态）——
    // 末尾的 running 占位 turn 必须压过它，否则回复后会闪回上一个 pause。
    const s = snap([proposeAction("1", { message: "Draft ready?" }), userTurn("2", "yes"), runningTurn("3")]);
    expect(s.status).toBe("running");
  });

  test("busy (in-flight, no trailing running entry yet) overrides a settled tail → running", () => {
    // runtime.busy = 旧 history page 的 active != null。regenerate 在途 / resync 到
    // active turn 但首帧未达时末尾还是上一个已结束的 turn——busy 必须压成 running，
    // 否则 drawer 状态条会闪成 pending_done 直到首帧到达才自愈。
    const s = snap([userTurn("1", "go"), textTurn("2", "done")], { awaitingDecision: null, busy: true });
    expect(s.status).toBe("running");
    expect(s.metadata.inFlight).toBe(true);
  });

  test("last entry is user → running (agent presumably mid-turn)", () => {
    expect(snap([userTurn("1", "do it")]).status).toBe("running");
  });

  test("last assistant has running tool → running", () => {
    expect(snap([proposeAction("1", { message: "thinking" }, { status: "running" })]).status).toBe("running");
  });

  test("trailing propose_action → needs_input with pendingInput + input_required event", () => {
    const s = snap([
      userTurn("1", "go"),
      proposeAction("2", { message: "Send this draft?", options: ["Send", "Edit"], plan: [{ tool: "gmail", summary: "send" }] }),
    ]);
    expect(s.status).toBe("needs_input");
    expect(s.pendingInput?.message).toBe("Send this draft?");
    expect(s.pendingInput?.options).toEqual(["Send", "Edit"]);
    expect(s.events.map((e) => e.type)).toEqual(["chat:tool:start", "chat:tool:result", "input_required"]);
  });

  test("text-only completion → pending_done with summary", () => {
    const s = snap([userTurn("1", "go"), textTurn("2", "All done. Sent the email.")]);
    expect(s.status).toBe("pending_done");
    expect(s.result?.summary).toBe("All done. Sent the email.");
  });

  test("trailing errored tool with nothing past it → error", () => {
    const s = snap([toolTurn("1", "python_exec", "error")]);
    expect(s.status).toBe("error");
    expect(s.errorMessage).toMatch(/failed/);
  });
});

describe("deriveRunSnapshot — plan_revisions pairing", () => {
  test("pairs each propose_action with the NEXT user reply, stripping legacy wrapper", () => {
    const legacyWrapped = [
      "<current_feedback_card>",
      JSON.stringify({ card_id: "card-1" }),
      "</current_feedback_card>",
      "",
      "User message:",
      "改成下午发",
    ].join("\n");
    const s = snap([
      proposeAction("1", { message: "v1?" }),
      userTurn("2", legacyWrapped),
      proposeAction("3", { message: "v2?" }),
    ]);
    const revisions = s.metadata.plan_revisions as Array<{ reply: string }>;
    expect(revisions).toEqual([{ reply: "改成下午发" }]);
    // 第二个 propose_action 还没有 user 回复 → 不产生 revision，且是当前 pause。
    expect(s.status).toBe("needs_input");
    expect(s.pendingInput?.message).toBe("v2?");
  });
});

describe("derived projections", () => {
  test("deriveLastMessagePayload merges audit fields forward across re-drafts", () => {
    const s = snap([
      proposeAction("1", { message: "v1", plan: [{ tool: "gmail", summary: "send" }], risks: ["sends email"] }),
      userTurn("2", "tweak it"),
      // Re-draft omits plan/risks（agent 常见行为）——audit 必须前向保留。
      proposeAction("3", { message: "v2" }),
    ]);
    const payload = deriveLastMessagePayload(s.events);
    expect(payload?.message).toBe("v2");
    expect(payload?.plan).toEqual([{ tool: "gmail", summary: "send" }]);
    expect(payload?.risks).toEqual(["sends email"]);
  });

  test("countProposeActions counts message-kind input_required events", () => {
    const s = snap([
      proposeAction("1", { message: "v1" }),
      userTurn("2", "again"),
      proposeAction("3", { message: "v2" }),
    ]);
    expect(countProposeActions(s.events)).toBe(2);
  });
});

describe("cardSessionKeyFor", () => {
  test("prefixes bare card ids and passes through session keys", () => {
    expect(cardSessionKeyFor("card-9")).toBe("card-thread-card-9");
    expect(cardSessionKeyFor("card-thread-card-9")).toBe("card-thread-card-9");
  });
});
