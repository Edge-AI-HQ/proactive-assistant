/**
 * Unit + hook tests for the proactive runtime — covers the bits added by
 * the cursor-pagination + Debug-aware filter rework:
 *   1. `partsHaveNotifyUser` (live-stream filter parity with backend rule)
 *   2. `historyToEntries` correctly tags tick-triggered turns as debug
 *   3. `loadMoreHistory` prepends an older page and updates the cursor
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ConversationContentPart } from "./tool-steps";
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
} from "./useConversationRuntime";

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

    // Stale assistant turn dropped locally; the user turn stays put.
    expect(result.current.transcript.map((e) => e.id)).toEqual(["u-1"]);
    // Backend re-run with the regenerate flag + the latest user text (it diffs
    // `message`, not `messages`, then pops the stale AIMessage).
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("card-thread-z", "summarize this", {
      regenerate: true,
    });
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
