/**
 * Unit + hook tests for the proactive runtime — covers the bits added by
 * the cursor-pagination + Debug-aware filter rework:
 *   1. `partsHaveNotifyUser` (live-stream filter parity with backend rule)
 *   2. `historyToEntries` correctly tags tick-triggered turns as debug
 *   3. `loadMoreHistory` prepends an older page and updates the cursor
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ConversationContentPart } from "@/components/chat/conversation/tool-steps";
import type { ConversationHistoryPage, ConversationHistoryMessage } from "@/lib/api";

// `@/lib/api` is mocked: history is the only thing tested here so the
// stream is a no-op async iterator and the enabled-toggle resolves false.
vi.mock("@/lib/api", () => ({
  conversationHistory: vi.fn(),
  // Yield nothing then return so the stream loop exits and the hook idles.
  conversationStream: vi.fn(() => (async function* () {})()),
  conversationSend: vi.fn(async () => {}),
  conversationCancel: vi.fn(async () => {}),
  conversationDecision: vi.fn(async () => {}),
  conversationInit: vi.fn(async () => ({
    sessionKey: "proactive-1",
    kind: "proactive",
    existing: false,
  })),
  fetchProactiveEnabled: vi.fn(async () => false),
  setProactiveEnabled: vi.fn(async (next: boolean) => next),
}));

import { conversationHistory, conversationSend, conversationStream } from "@/lib/api";
import {
  historyToEntries,
  partsHaveNotifyUser,
  useConversationRuntime,
  type ConversationAssistantEntry,
  type ConversationUserEntry,
} from "@/components/chat/conversation/useConversationRuntime";

const fetchHistoryMock = conversationHistory as unknown as ReturnType<
  typeof vi.fn
>;
const streamMock = conversationStream as unknown as ReturnType<typeof vi.fn>;
const sendMock = conversationSend as unknown as ReturnType<typeof vi.fn>;

function page(
  messages: ConversationHistoryMessage[],
  extras: Partial<ConversationHistoryPage> = {},
): ConversationHistoryPage {
  return {
    messages,
    nextCursor: extras.nextCursor ?? null,
    awaiting: extras.awaiting ?? null,
    active: extras.active ?? null,
  };
}

function emptyStream() {
  return (async function* () {
    /* no events */
  })();
}

// ─── partsHaveNotifyUser ──────────────────────────────────────────────


describe("partsHaveNotifyUser", () => {
  test("returns true when a tool-call part is notify_user", () => {
    const parts: ConversationContentPart[] = [
      { type: "reasoning", text: "thinking…" },
      {
        type: "tool-call",
        toolCallId: "n",
        toolName: "notify_user",
        args: { status: "ok" },
        argsText: "",
      },
    ];
    expect(partsHaveNotifyUser(parts)).toBe(true);
  });

  test("returns false when only other tools are present", () => {
    const parts: ConversationContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "m",
        toolName: "memory_search",
        args: { status: "ok" },
        argsText: "",
      },
      { type: "text", text: "private thinking" },
    ];
    expect(partsHaveNotifyUser(parts)).toBe(false);
  });

  test("returns false on an empty parts list", () => {
    expect(partsHaveNotifyUser([])).toBe(false);
  });
});

// ─── historyToEntries ─────────────────────────────────────────────────


describe("historyToEntries", () => {
  test("tick trigger on assistant entry sets debug=true", () => {
    const out = historyToEntries([
      { id: "hb-1", role: "heartbeat", parts: [{ type: "text", text: "[heartbeat]" }] },
      {
        id: "a-tick",
        role: "assistant",
        trigger: "tick",
        parts: [{ type: "text", text: "silent" }],
      },
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a-user",
        role: "assistant",
        trigger: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(out).toHaveLength(4);
    expect(out[0].kind).toBe("heartbeat");
    const tickTurn = out[1] as ConversationAssistantEntry;
    expect(tickTurn.kind).toBe("assistant");
    expect(tickTurn.debug).toBe(true);
    expect(out[2].kind).toBe("user");
    const userTurn = out[3] as ConversationAssistantEntry;
    expect(userTurn.debug).toBe(false);
  });

  test("legacy [heartbeat] text on a user-role message still classifies as debug input", () => {
    // Older backend emits the heartbeat as `role=user` text starting with
    // `[heartbeat]`; the assistant turn that follows should still be tagged
    // debug even when the message lacks a `trigger` field.
    const out = historyToEntries([
      { id: "hb-1", role: "user", parts: [{ type: "text", text: "[heartbeat] 10:00" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "…" }] },
    ]);
    expect(out[0].kind).toBe("heartbeat");
    expect((out[1] as ConversationAssistantEntry).debug).toBe(true);
  });
});

// ─── loadMoreHistory ──────────────────────────────────────────────────


describe("useConversationRuntime.loadMoreHistory", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
  });

  test("prepends an older page and updates the cursor", async () => {
    // First (newest) page → has more, cursor points at its oldest entry.
    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [
          {
            id: "u-2",
            role: "user",
            parts: [{ type: "text", text: "second" }],
          },
          {
            id: "a-2",
            role: "assistant",
            parts: [{ type: "text", text: "reply 2" }],
          },
        ],
        { nextCursor: 100 },
      ),
    );
    // Second (older) page → no more pages after this.
    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [
          {
            id: "u-1",
            role: "user",
            parts: [{ type: "text", text: "first" }],
          },
          {
            id: "a-1",
            role: "assistant",
            parts: [{ type: "text", text: "reply 1" }],
          },
        ],
        { nextCursor: null },
      ),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-x" }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.transcript.map((e) => e.id)).toEqual(["u-2", "a-2"]);
    expect(result.current.hasMoreHistory).toBe(true);

    await act(async () => {
      await result.current.loadMoreHistory();
    });

    // Older page prepended; transcript now time-ascending across both pages.
    expect(result.current.transcript.map((e) => e.id)).toEqual([
      "u-1", "a-1", "u-2", "a-2",
    ]);
    expect(result.current.hasMoreHistory).toBe(false);
    // Backend was asked for the older page with the right cursor.
    expect(fetchHistoryMock).toHaveBeenCalledTimes(2);
    const lastCall = fetchHistoryMock.mock.calls[1];
    expect(lastCall[1]).toMatchObject({ before: 100 });
  });

  test("no-ops when there is no cursor / no more pages", async () => {
    fetchHistoryMock.mockResolvedValueOnce(
      page([
        { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-y" }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.hasMoreHistory).toBe(false);

    await act(async () => {
      await result.current.loadMoreHistory();
    });

    // Only the initial fetch — no older-page request fired.
    expect(fetchHistoryMock).toHaveBeenCalledTimes(1);
  });
});

// ─── regenerateLast ───────────────────────────────────────────────────


describe("useConversationRuntime.regenerateLast", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
  });

  test("drops the trailing assistant turn and re-sends the latest user text with regenerate=true", async () => {
    fetchHistoryMock.mockResolvedValueOnce(
      page([
        { id: "u-1", role: "user", parts: [{ type: "text", text: "summarize this" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "here you go" }] },
      ]),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-z" }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.transcript.map((e) => e.id)).toEqual(["u-1", "a-1"]);

    await act(async () => {
      await result.current.regenerateLast();
    });

    // Stale assistant turn dropped locally; the user turn stays put and an
    // optimistic placeholder (running, empty) takes the dropped turn's place
    // so the pill shows without waiting for the first frame.
    expect(result.current.transcript.map((e) => e.kind)).toEqual([
      "user", "assistant",
    ]);
    expect(result.current.transcript[0].id).toBe("u-1");
    const placeholder = result.current.transcript[1] as ConversationAssistantEntry;
    expect(placeholder.id).not.toBe("a-1");
    expect(placeholder.running).toBe(true);
    expect(placeholder.parts).toEqual([]);
    // Backend re-run with the regenerate flag + the latest user text (it diffs
    // `message`, not `messages`, then pops the stale AIMessage). clientMsgId
    // rides along so a retried-after-timeout regenerate can't double-enqueue.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      "card-thread-z",
      "summarize this",
      expect.objectContaining({ regenerate: true, clientMsgId: expect.any(String) }),
    );
  });

  test("no-ops when there is no user turn to regenerate", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-empty" }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.regenerateLast();
    });

    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── HITL gate reconnect ──────────────────────────────────────────────


describe("useConversationRuntime HITL reconnect", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
  });

  test("rebuilds the gate AND the in-progress turn from history.awaiting on (re)connect", async () => {
    // /stream is live-only and never replays requires_action, so a refresh
    // restores the paused gate + the partial turn purely from /history.
    fetchHistoryMock.mockResolvedValueOnce(
      page([{ id: "u-1", role: "user", parts: [{ type: "text", text: "send it" }] }], {
        awaiting: {
          toolUseId: "int-1",
          toolName: "GMAIL_SEND_DRAFT",
          argsPreview: "to: x@y.com",
          allowedDecisions: ["approve", "reject"],
          // reasoning + tool-call streamed before the interrupt (not persisted).
          partialParts: [
            { type: "reasoning", text: "Drafting the email…" },
            { type: "tool-call", toolCallId: "t1", toolName: "GMAIL_SEND_DRAFT", status: "running" },
          ],
        },
      }),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-h" }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    // Gate carries only the decision fields (partialParts redrew the turn, not
    // the gate) — matching the live requires_action shape.
    expect(result.current.awaitingDecision).toEqual({
      toolUseId: "int-1",
      toolName: "GMAIL_SEND_DRAFT",
      argsPreview: "to: x@y.com",
      allowedDecisions: ["approve", "reject"],
    });
    // The in-progress turn is redrawn above the gate (NOT wiped): user turn +
    // a partial assistant turn carrying the pre-interrupt reasoning + tool-call.
    expect(result.current.transcript).toHaveLength(2);
    const partial = result.current.transcript[1];
    expect(partial.kind).toBe("assistant");
    if (partial.kind === "assistant") {
      expect(partial.running).toBe(true);
      expect(
        partial.parts.some((p) => p.type === "reasoning" && p.text === "Drafting the email…"),
      ).toBe(true);
      expect(
        partial.parts.some((p) => p.type === "tool-call" && p.toolName === "GMAIL_SEND_DRAFT"),
      ).toBe(true);
    }
  });

  test("clears a stale gate when history reports no awaiting (run resolved)", async () => {
    fetchHistoryMock.mockResolvedValueOnce(
      page([{ id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] }]),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-h2" }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.awaitingDecision).toBeNull();
  });
});

// ─── Debug toggle ─────────────────────────────────────────────────────


describe("useConversationRuntime Debug toggle", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    fetchHistoryMock.mockResolvedValue(page([]));
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
  });

  test("refetches history with includeDebug when the Debug toggle flips", async () => {
    // The Debug toggle must rebuild the transcript from the server: heartbeat +
    // silent-tick rows live only in pai_chat_messages behind include_debug, so
    // flipping debugEnabled re-runs the connect effect with the matching filter.
    // Without debugEnabled in the effect deps the toggle would only gate live
    // events and a reconnect would drop those rows (the original bug).
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "proactive-1", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    // Default view asks for the filtered (non-debug) page.
    expect(fetchHistoryMock).toHaveBeenLastCalledWith(
      "proactive-1",
      expect.objectContaining({ includeDebug: false }),
    );

    rerender({ debug: true });
    // Toggling Debug on re-fetches with includeDebug=true.
    await waitFor(() =>
      expect(fetchHistoryMock).toHaveBeenLastCalledWith(
        "proactive-1",
        expect.objectContaining({ includeDebug: true }),
      ),
    );
  });
});

// ─── In-flight user bubble merge ──────────────────────────────────────


describe("useConversationRuntime in-flight user bubble merge", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
  });

  const userEntries = (entries: { kind: string }[]) =>
    entries.filter((e): e is ConversationUserEntry => e.kind === "user");

  test("a history refetch mid-turn does not duplicate the just-sent bubble", async () => {
    // Regression: until the turn finalizes into pai_chat_messages, the sent
    // message exists BOTH as the local optimistic bubble and as
    // `page.active.userTexts` (the unconsumed mailbox row). A refetch in that
    // window (resync / debug toggle / reconnect before the first frame) used
    // to render both copies.
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-1", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("你是kimi 2.6吗");
    });
    expect(userEntries(result.current.transcript)).toHaveLength(1);

    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [{ id: "a-0", role: "assistant", parts: [{ type: "text", text: "earlier reply" }] }],
        { active: { userTexts: ["你是kimi 2.6吗"], replayFrom: null } },
      ),
    );
    rerender({ debug: true });
    // `a-0` landing proves the refetched rebuild has been applied.
    await waitFor(() =>
      expect(result.current.transcript.some((e) => e.id === "a-0")).toBe(true),
    );

    const users = userEntries(result.current.transcript);
    expect(users).toHaveLength(1);
    expect(users[0].text).toBe("你是kimi 2.6吗");
  });

  test("restores the in-flight bubble from userTexts when no local bubble survives (reload)", async () => {
    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [{ id: "a-0", role: "assistant", parts: [{ type: "text", text: "earlier reply" }] }],
        { active: { userTexts: ["resumed question"], replayFrom: null } },
      ),
    );
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-2" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const users = userEntries(result.current.transcript);
    expect(users).toHaveLength(1);
    expect(users[0].text).toBe("resumed question");
    // The restored bubble renders after the persisted history rows.
    expect(result.current.transcript.map((e) => e.kind)).toEqual([
      "assistant", "user",
    ]);
  });

  test("repeated identical sends stay distinct across a refetch", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-3", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("again");
    });
    await act(async () => {
      await result.current.sendMessage("again");
    });
    expect(userEntries(result.current.transcript)).toHaveLength(2);

    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [{ id: "a-0", role: "assistant", parts: [{ type: "text", text: "earlier" }] }],
        { active: { userTexts: ["again", "again"], replayFrom: null } },
      ),
    );
    rerender({ debug: true });
    await waitFor(() =>
      expect(result.current.transcript.some((e) => e.id === "a-0")).toBe(true),
    );
    // Each pending text claims one local bubble — exactly two, not one, not four.
    expect(userEntries(result.current.transcript)).toHaveLength(2);
  });

  test("sends carry a clientMsgId and a retry reuses the same one (idempotent resend)", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-5" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    sendMock.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const firstOpts = sendMock.mock.calls[0][2] as { clientMsgId?: string };
    expect(firstOpts.clientMsgId).toBeTruthy();

    const bubble = userEntries(result.current.transcript)[0];
    expect(bubble.failed).toBe(true);
    expect(bubble.clientId).toBe(firstOpts.clientMsgId);

    // Retry rides the entry id — which IS the client message id — so the
    // backend's idempotent enqueue dedupes a timed-out-but-landed first POST.
    await act(async () => {
      await result.current.retryMessage(bubble.id, bubble.text);
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    const retryOpts = sendMock.mock.calls[1][2] as { clientMsgId?: string };
    expect(retryOpts.clientMsgId).toBe(firstOpts.clientMsgId);
  });

  test("reconciles by clientId when the backend reports userEntries", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-6", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("ping");
    });
    const sent = userEntries(result.current.transcript)[0];
    expect(sent.clientId).toBeTruthy();

    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [{ id: "a-0", role: "assistant", parts: [{ type: "text", text: "earlier" }] }],
        {
          active: {
            userTexts: ["ping"],
            userEntries: [{ text: "ping", clientId: sent.clientId! }],
            replayFrom: null,
          },
        },
      ),
    );
    rerender({ debug: true });
    await waitFor(() =>
      expect(result.current.transcript.some((e) => e.id === "a-0")).toBe(true),
    );
    expect(userEntries(result.current.transcript)).toHaveLength(1);
  });

  test("same text, different message: a history row with another clientId does not swallow the new bubble", async () => {
    // The text heuristic's blind spot: the user said "继续" last turn (already
    // persisted) and says "继续" again now. Identity reconciliation must keep
    // the new optimistic bubble while a text-keyed carry would drop it.
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-7", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("继续");
    });
    const sent = userEntries(result.current.transcript)[0];

    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [
          {
            id: "u-old",
            role: "user",
            parts: [{ type: "text", text: "继续" }],
            clientMsgId: "earlier-uuid",
          },
          { id: "a-old", role: "assistant", parts: [{ type: "text", text: "done" }] },
        ],
        {
          active: {
            userTexts: ["继续"],
            userEntries: [{ text: "继续", clientId: sent.clientId! }],
            replayFrom: null,
          },
        },
      ),
    );
    rerender({ debug: true });
    await waitFor(() =>
      expect(result.current.transcript.some((e) => e.id === "u-old")).toBe(true),
    );
    // Two bubbles: last turn's persisted one + this turn's in-flight one.
    const users = userEntries(result.current.transcript);
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.clientId)).toEqual(["earlier-uuid", sent.clientId]);
  });

  test("an id-bearing pending entry never text-claims a different message's bubble (two tabs, same text)", async () => {
    // Tab A's bubble (uuid-1, POST in flight) and tab B's pending send
    // (uuid-2, same text) are DIFFERENT messages. Identity reconciliation
    // must restore uuid-2 as its own bubble, not swallow it into uuid-1 via
    // the text-claim fallback (which is reserved for id-less entries from
    // older backends).
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-9", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("hello");
    });
    const local = userEntries(result.current.transcript)[0];

    fetchHistoryMock.mockResolvedValueOnce(
      page([], {
        active: {
          userTexts: ["hello"],
          userEntries: [{ text: "hello", clientId: "other-tab-uuid" }],
          replayFrom: null,
        },
      }),
    );
    rerender({ debug: true });
    await waitFor(() =>
      expect(userEntries(result.current.transcript)).toHaveLength(2),
    );
    const ids = userEntries(result.current.transcript).map((e) => e.clientId);
    expect(ids).toContain(local.clientId);
    expect(ids).toContain("other-tab-uuid");
  });

  test("clears a stale failed flag when the mailbox proves the send landed", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-8", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // POST times out client-side but actually landed server-side.
    sendMock.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    const bubble = userEntries(result.current.transcript)[0];
    expect(bubble.failed).toBe(true);

    fetchHistoryMock.mockResolvedValueOnce(
      page([], {
        active: {
          userTexts: ["hello"],
          userEntries: [{ text: "hello", clientId: bubble.clientId! }],
          replayFrom: null,
        },
      }),
    );
    rerender({ debug: true });
    await waitFor(() => {
      const users = userEntries(result.current.transcript);
      expect(users).toHaveLength(1);
      expect(users[0].failed).toBe(false);
    });
  });

  test("a failed bubble does not absorb a pending text (failed sends never reached the mailbox)", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ debug }) =>
        useConversationRuntime({ session: "main-4", debugEnabled: debug }),
      { initialProps: { debug: false } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    sendMock.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    const afterFail = userEntries(result.current.transcript);
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0].failed).toBe(true);

    // The server reports an EARLIER send of the same text still in flight
    // (e.g. sent before a reload). The failed bubble must not claim it —
    // both the retryable bubble and the pending one render.
    fetchHistoryMock.mockResolvedValueOnce(
      page([], { active: { userTexts: ["hello"], replayFrom: null } }),
    );
    rerender({ debug: true });
    await waitFor(() =>
      expect(userEntries(result.current.transcript)).toHaveLength(2),
    );
    const users = userEntries(result.current.transcript);
    expect(users.some((e) => e.failed)).toBe(true);
    expect(users.some((e) => !e.failed)).toBe(true);
  });
});

// ─── Optimistic turn placeholder ──────────────────────────────────────


describe("useConversationRuntime optimistic turn placeholder", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
  });

  const assistantEntries = (entries: { kind: string }[]) =>
    entries.filter(
      (e): e is ConversationAssistantEntry => e.kind === "assistant",
    );

  test("a send opens a running placeholder turn immediately", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-p1" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.transcript.map((e) => e.kind)).toEqual([
      "user", "assistant",
    ]);
    const turn = assistantEntries(result.current.transcript)[0];
    expect(turn.running).toBe(true);
    expect(turn.parts).toEqual([]);
    expect(turn.debug).toBe(false);
  });

  test("a failed send drops the idle placeholder, keeping the failed bubble", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-p2" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    sendMock.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.transcript.map((e) => e.kind)).toEqual(["user"]);
    expect(userEntriesOf(result.current.transcript)[0].failed).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  test("the placeholder is skipped while a foreign turn is mid-stream", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    // A heartbeat-triggered turn is already streaming when the user sends:
    // its builder isn't ours to reuse, so the send must NOT open a second
    // assistant entry.
    streamMock.mockImplementation(() =>
      (async function* () {
        yield {
          event: { type: "chat:thinking", traceId: "run-1", data: {} },
          lastEventId: "1",
        };
        // Hold the stream open so the foreign turn never finalizes.
        await new Promise(() => {});
      })(),
    );
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "proactive-p3" }),
    );
    await waitFor(() =>
      expect(assistantEntries(result.current.transcript)).toHaveLength(1),
    );

    await act(async () => {
      await result.current.sendMessage("hi");
    });
    expect(assistantEntries(result.current.transcript)).toHaveLength(1);
  });

  test("a tick turn arriving after the send drops the idle placeholder instead of adopting it", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    // Controllable stream: frames are pushed mid-test, AFTER the send has
    // already created the optimistic placeholder.
    const queue: { event: Record<string, unknown>; lastEventId: string }[] = [];
    let notify: (() => void) | null = null;
    const push = (event: Record<string, unknown>) => {
      queue.push({ event, lastEventId: String(queue.length + 1) });
      notify?.();
    };
    streamMock.mockImplementation(() =>
      (async function* () {
        while (true) {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
          yield queue.shift();
        }
      })(),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "proactive-p5", debugEnabled: false }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("hi");
    });
    expect(assistantEntries(result.current.transcript)).toHaveLength(1);

    // A heartbeat tick's turn starts BEFORE the user's turn. Its frames must
    // not adopt the placeholder builder: with Debug off the gate would
    // swallow every flush and strand a running/empty entry forever.
    await act(async () => {
      push({ type: "proactive:tick", traceId: "run-tick", data: { text: "[heartbeat]", windowEnd: "w" } });
      push({ type: "chat:thinking", traceId: "run-tick", data: {} });
      push({ type: "chat:delta", traceId: "run-tick", data: { delta: "silent work" } });
      push({ type: "chat:done", traceId: "run-tick", data: {} });
    });
    await waitFor(() =>
      expect(assistantEntries(result.current.transcript)).toHaveLength(0),
    );

    // The user's own turn then opens normally.
    await act(async () => {
      push({ type: "chat:thinking", traceId: "run-user", data: {} });
      push({ type: "chat:delta", traceId: "run-user", data: { delta: "answer" } });
    });
    await waitFor(() => {
      const turns = assistantEntries(result.current.transcript);
      expect(turns).toHaveLength(1);
      expect(turns[0].parts).toEqual([{ type: "text", text: "answer" }]);
    });
  });

  test("stop drops a placeholder that never streamed", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-p4" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(assistantEntries(result.current.transcript)).toHaveLength(1);
    await act(async () => {
      await result.current.stop();
    });
    expect(assistantEntries(result.current.transcript)).toHaveLength(0);
    expect(result.current.busy).toBe(false);
  });
});

function userEntriesOf(entries: { kind: string }[]) {
  return entries.filter(
    (e): e is ConversationUserEntry => e.kind === "user",
  );
}
