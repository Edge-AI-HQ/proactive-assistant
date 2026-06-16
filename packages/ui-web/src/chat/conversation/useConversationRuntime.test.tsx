/**
 * Unit + hook tests for the conversation runtime:
 *   1. `partsHaveNotifyUser` (notify_user detection)
 *   2. `loadMoreHistory` prepends an older page and updates the cursor
 *   3. send / queue / regenerate / HITL reconnect
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useConversationRuntime } from "@pin-ai/state";
import { type ConversationContentPart, type ConversationHistoryPage, type ConversationHistoryMessage, historyToEntries, partsHaveNotifyUser, type ConversationAssistantEntry, type ConversationUserEntry } from "@pin-ai/core";

// Phase 3 后 hook 在 @pin-ai/state、HTTP 走 @pin-ai/core——partial-mock core
// 包（保留 historyToEntries 等纯函数），history 是主要被测面；stream 是
// no-op async iterator 让循环退出、hook 空转。
vi.mock("@pin-ai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pin-ai/core")>();
  return {
    ...actual,
    conversationHistory: vi.fn(),
    // Yield nothing then return so the stream loop exits and the hook idles.
    conversationStream: vi.fn(() => (async function* () {})()),
    conversationSend: vi.fn(async () => {}),
    conversationUpdateMessage: vi.fn(async () => {}),
    conversationDeleteMessage: vi.fn(async () => {}),
    conversationCancel: vi.fn(async () => {}),
    conversationDecision: vi.fn(async () => {}),
    conversationInit: vi.fn(async () => ({
      sessionKey: "main-1",
      kind: "main",
      existing: false,
    })),
  };
});

import { conversationDeleteMessage, conversationHistory, conversationSend, conversationStream, conversationUpdateMessage } from "@pin-ai/core";

const fetchHistoryMock = conversationHistory as unknown as ReturnType<
  typeof vi.fn
>;
const streamMock = conversationStream as unknown as ReturnType<typeof vi.fn>;
const sendMock = conversationSend as unknown as ReturnType<typeof vi.fn>;
const updateMessageMock = conversationUpdateMessage as unknown as ReturnType<typeof vi.fn>;
const deleteMessageMock = conversationDeleteMessage as unknown as ReturnType<typeof vi.fn>;

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

  test("restores queued user entries from active history after reload", async () => {
    fetchHistoryMock.mockResolvedValueOnce(
      page(
        [{ id: "a-0", role: "assistant", parts: [{ type: "text", text: "earlier reply" }] }],
        {
          active: {
            userTexts: ["current run", "queued follow-up"],
            userEntries: [
              { text: "current run", clientId: "run-1" },
              { text: "queued follow-up", clientId: "queue-1", queued: true },
            ],
            replayFrom: null,
          },
        },
      ),
    );
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-queued-reload" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const users = userEntries(result.current.transcript);
    expect(users.map((u) => [u.text, !!u.queued])).toEqual([
      ["current run", false],
      ["queued follow-up", true],
    ]);
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
    // Another turn is already streaming when the user sends: its builder isn't
    // ours to reuse, so the send must NOT open a second assistant entry.
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
      useConversationRuntime({ session: "main-p3" }),
    );
    await waitFor(() =>
      expect(assistantEntries(result.current.transcript)).toHaveLength(1),
    );

    await act(async () => {
      await result.current.sendMessage("hi");
    });
    expect(assistantEntries(result.current.transcript)).toHaveLength(1);
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

  test("chat:done fires onTurnDone so the card layer can sync its status", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
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

    const onTurnDone = vi.fn();
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "card-thread-td", onTurnDone }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      push({ type: "chat:thinking", traceId: "run-1", data: {} });
      push({ type: "chat:delta", traceId: "run-1", data: { delta: "result" } });
    });
    expect(onTurnDone).not.toHaveBeenCalled();
    await act(async () => {
      push({ type: "chat:done", traceId: "run-1", data: {} });
    });
    await waitFor(() => expect(onTurnDone).toHaveBeenCalledTimes(1));

    // A HITL pause settles the turn for the card layer too (needs_input).
    await act(async () => {
      push({ type: "chat:thinking", traceId: "run-2", data: {} });
      push({
        type: "chat:requires_action",
        traceId: "run-2",
        data: { interruptId: "int-1", toolName: "send_email", allowedDecisions: ["approve"] },
      });
    });
    await waitFor(() => expect(onTurnDone).toHaveBeenCalledTimes(2));
    expect(result.current.awaitingDecision).not.toBeNull();

    // chat:done clears the parked approval card: it can only mean the turn
    // moved on without this device's decision — another device approved (the
    // resume's own done) or the run was cancelled while paused (the
    // service-published terminal frame). The bus never carries a done for a
    // turn still paused (the worker stops relaying at the pause frame).
    await act(async () => {
      push({ type: "chat:done", traceId: "run-2", data: {} });
    });
    await waitFor(() => expect(result.current.awaitingDecision).toBeNull());
  });
});

describe("useConversationRuntime queued user messages", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
    updateMessageMock.mockReset();
    updateMessageMock.mockResolvedValue(undefined);
    deleteMessageMock.mockReset();
    deleteMessageMock.mockResolvedValue(undefined);
  });

  async function renderWithTwoSends(session = "main-q1") {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
    const rendered = renderHook(() => useConversationRuntime({ session }));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await act(async () => {
      await rendered.result.current.sendMessage("first");
    });
    await act(async () => {
      await rendered.result.current.sendMessage("second");
    });
    return rendered;
  }

  test("a send while busy is marked queued and does not open another assistant placeholder", async () => {
    const { result } = await renderWithTwoSends("main-q1");

    const users = userEntriesOf(result.current.transcript);
    expect(users.map((u) => [u.text, !!u.queued])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    const assistants = result.current.transcript.filter(
      (e): e is ConversationAssistantEntry => e.kind === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  test("updates a queued message locally and on the backend", async () => {
    const { result } = await renderWithTwoSends("main-q2");
    const queued = userEntriesOf(result.current.transcript)[1];

    await act(async () => {
      await result.current.updateQueuedMessage(queued.id, "edited second");
    });

    expect(updateMessageMock).toHaveBeenCalledWith(
      "main-q2",
      queued.clientId,
      "edited second",
    );
    const users = userEntriesOf(result.current.transcript);
    expect(users[1].text).toBe("edited second");
    expect(users[1].queued).toBe(true);
  });

  test("deletes a queued message locally and on the backend", async () => {
    const { result } = await renderWithTwoSends("main-q3");
    const queued = userEntriesOf(result.current.transcript)[1];

    await act(async () => {
      await result.current.deleteQueuedMessage(queued.id);
    });

    expect(deleteMessageMock).toHaveBeenCalledWith("main-q3", queued.clientId);
    expect(userEntriesOf(result.current.transcript).map((u) => u.text)).toEqual(["first"]);
  });

  test("force-sending a queued message interrupts the current run with the same client id", async () => {
    const { result } = await renderWithTwoSends("main-q4");
    const queued = userEntriesOf(result.current.transcript)[1];

    await act(async () => {
      await result.current.interruptQueuedMessage(queued.id);
    });

    expect(sendMock).toHaveBeenLastCalledWith(
      "main-q4",
      "second",
      expect.objectContaining({
        clientMsgId: queued.clientId,
        interrupt: true,
      }),
    );
    expect(userEntriesOf(result.current.transcript)[1].queued).toBe(false);
  });
});

function userEntriesOf(entries: { kind: string }[]) {
  return entries.filter(
    (e): e is ConversationUserEntry => e.kind === "user",
  );
}

describe("useConversationRuntime B3b local-first read", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    streamMock.mockImplementation(() => emptyStream());
  });

  test("renders the local page immediately (ready before network), then the network page corrects", async () => {
    const localHistory = vi.fn(async () =>
      page(
        [{ id: "1", role: "user" as const, parts: [{ type: "text" as const, text: "from local" }] }],
        { nextCursor: null },
      ),
    );
    // 网络页慢到：本地页先渲染（ready），网络到达后整体重建为权威数据。
    let resolveNetwork: (p: ConversationHistoryPage) => void = () => {};
    fetchHistoryMock.mockImplementationOnce(
      () => new Promise<ConversationHistoryPage>((r) => (resolveNetwork = r)),
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-1", localHistory }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.transcript.map((e) => e.kind === "user" && e.text)).toContain(
      "from local",
    );

    await act(async () => {
      resolveNetwork(
        page([
          { id: "1", role: "user", parts: [{ type: "text", text: "from local" }] },
          { id: "2", role: "assistant", parts: [{ type: "text", text: "network reply" }] },
        ]),
      );
    });
    await waitFor(() =>
      expect(
        result.current.transcript.some(
          (e) => e.kind === "assistant" && e.parts.some((p) => p.type === "text" && p.text === "network reply"),
        ),
      ).toBe(true),
    );
    // 本地与网络同源同 id —— 不重复。
    expect(result.current.transcript).toHaveLength(2);
  });

  test("null local page (cold/no driver) falls straight through to network", async () => {
    const localHistory = vi.fn(async () => null);
    fetchHistoryMock.mockResolvedValueOnce(
      page([{ id: "1", role: "user", parts: [{ type: "text", text: "net only" }] }]),
    );
    const { result } = renderHook(() =>
      useConversationRuntime({ session: "main-1", localHistory }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.transcript).toHaveLength(1);
    expect(localHistory).toHaveBeenCalled();
  });
});

describe("turn boundary on traceId change", () => {
  test("a cancelled HITL turn is closed when the next turn starts streaming", async () => {
    // 场景（真机实测 bug）：turn1 暂停在 requires_action（无 chat:done），
    // 用户插话 → 后端取消 turn1、turn2 直接开流。修复前 turn2 的帧全部
    // 续进 turn1 的 entry（渲染在历史中段）；修复后 traceId 变化触发
    // finalize，turn2 是独立的末尾 entry，作废的审批卡被清掉。
    fetchHistoryMock.mockResolvedValue(page([]));
    const frames = [
      { type: "chat:thinking", traceId: "t1", data: {} },
      { type: "chat:reasoning:delta", traceId: "t1", data: { delta: "old thinking" } },
      { type: "chat:delta", traceId: "t1", data: { delta: "old text" } },
      {
        type: "chat:requires_action",
        traceId: "t1",
        data: { interruptId: "i1", toolName: "GMAIL_SEND_DRAFT" },
      },
      { type: "chat:thinking", traceId: "t2", data: {} },
      { type: "chat:reasoning:delta", traceId: "t2", data: { delta: "new thinking" } },
      { type: "chat:done", traceId: "t2", data: {} },
    ];
    streamMock.mockReturnValue(
      (async function* () {
        for (const [i, event] of frames.entries()) {
          yield { event, lastEventId: String(i + 1) };
        }
      })(),
    );

    const { result } = renderHook(() => useConversationRuntime({ session: "main-1" }));
    await waitFor(() => {
      expect(result.current.transcript.filter((e) => e.kind === "assistant")).toHaveLength(2);
    });
    const assistants = result.current.transcript.filter(
      (e): e is ConversationAssistantEntry => e.kind === "assistant",
    );
    const hasNewThinking = (e: ConversationAssistantEntry) =>
      e.parts.some((p) => p.type === "reasoning" && p.text.includes("new thinking"));
    expect(assistants[0].running).toBe(false);
    expect(hasNewThinking(assistants[0])).toBe(false);
    expect(hasNewThinking(assistants[1])).toBe(true);
    expect(result.current.awaitingDecision).toBeNull();
  });
});

describe("chat:persisted adopts serverId without changing the list key", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    streamMock.mockReset();
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
  });

  test("a live turn keeps its 'turn-N' id; the real id lands in serverId (no remount flicker)", async () => {
    fetchHistoryMock.mockResolvedValueOnce(page([]));
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

    const { result } = renderHook(() => useConversationRuntime({ session: "main-persist" }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      push({ type: "chat:thinking", traceId: "run-1", data: {} });
      push({ type: "chat:delta", traceId: "run-1", data: { delta: "hello" } });
      push({ type: "chat:done", traceId: "run-1", data: {} });
    });
    const liveTurn = () =>
      result.current.transcript.find(
        (e): e is ConversationAssistantEntry => e.kind === "assistant",
      );
    await waitFor(() => expect(liveTurn()?.running).toBe(false));
    const liveId = liveTurn()!.id;
    // While streaming/just-done the turn has its client-local id and no serverId.
    expect(liveId.startsWith("turn-")).toBe(true);
    expect(liveTurn()!.serverId).toBeUndefined();

    await act(async () => {
      push({ type: "chat:persisted", traceId: "run-1", data: { messageId: "98765" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(liveTurn()?.serverId).toBe("98765"));
    // The key (id) MUST be unchanged — this is what prevents the remount flicker
    // (Virtuoso computeItemKey reads entry.id).
    expect(liveTurn()!.id).toBe(liveId);
  });
});
