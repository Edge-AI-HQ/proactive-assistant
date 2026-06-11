import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useCardActions } from "./useCardActions";
import type { ComposioState } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";

// Minimal ComposioState stub. useCardActions only consults it via
// tryHandleConnectorCard for the connect:* short-circuit, which never
// fires in these tests because baseCard.intentKey starts with "work:".
function stubComposio(): ComposioState {
  return {
    keyStatus: { configured: false },
    connections: [],
    statusLoading: false,
    loadingConns: false,
    loadStatus: vi.fn(async () => undefined),
    loadConnections: vi.fn(async () => []),
    loadCatalog: vi.fn(async () => ({ ok: true, page: { items: [], nextCursor: null, totalCount: null } })),
    connectToolkit: vi.fn(async () => ({ ok: true })),
    disconnectAccount: vi.fn(async () => ({ ok: true })),
    waitForToolkit: vi.fn(async () => ({ connected: true })),
    cancelWait: vi.fn(),
    isToolkitConnected: vi.fn(() => false),
    reconnectAccount: vi.fn(async () => ({ ok: true })),
    createCustomMcpConnector: vi.fn(async () => ({ ok: true })),
    updateCustomMcpConnector: vi.fn(async () => ({ ok: true })),
    deleteCustomMcpConnector: vi.fn(async () => ({ ok: true })),
  };
}

vi.mock("@/lib/api", () => ({
  proxyPost: vi.fn(async () => new Response("{}", { status: 200 })),
  // Default: both init endpoints return empty lists. Individual tests
  // override per-URL via mockImplementation when they need seeded data.
  proxyFetch: vi.fn(async (path: string) => {
    if (path === "/feedback/completed") {
      return new Response(JSON.stringify({ ok: true, completedCardIds: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, dismissedCardIds: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { proxyFetch, proxyPost } from "@/lib/api";

const baseCard: IntentCard = {
  id: "c1",
  intentKey: "work:review-pr",
  goalBasket: "work",
  title: "T",
  whyNow: "w",
  summary: "s",
  primaryAction: { label: "Draft a reply", type: "confirm" },
  secondaryActions: [],
  confidence: 0.9,
  urgency: 0.9,
  importance: 0.9,
  sources: [],
  agentChain: [],
  createdAt: "",
};

describe("useCardActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  test("init: pulls dismissed ids from /feedback/dismissed", async () => {
    (proxyFetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string) => {
        if (path === "/feedback/dismissed") {
          return new Response(
            JSON.stringify({ ok: true, dismissedCardIds: ["d1", "d2"] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, completedCardIds: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await waitFor(() => {
      expect(result.current.dismissedIds.has("d1")).toBe(true);
      expect(result.current.dismissedIds.has("d2")).toBe(true);
    });
    expect(proxyFetch).toHaveBeenCalledWith("/feedback/dismissed");
  });

  test("init: pulls completed ids from /feedback/completed", async () => {
    // Without this restore-on-mount, the sphere's doneIds Set starts
    // empty after refresh and completed cards visibly reappear until
    // the user re-clicks Done.
    (proxyFetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string) => {
        if (path === "/feedback/completed") {
          return new Response(
            JSON.stringify({ ok: true, completedCardIds: ["c9", "c10"] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, dismissedCardIds: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await waitFor(() => {
      expect(result.current.doneIds.has("c9")).toBe(true);
      expect(result.current.doneIds.has("c10")).toBe(true);
    });
    expect(proxyFetch).toHaveBeenCalledWith("/feedback/completed");
  });

  test("confirm: posts card_action + opens chat with primaryAction.label as bootstrap", async () => {
    const onOpenChat = vi.fn();
    const { result } = renderHook(() => useCardActions({ onOpenChat, composio: stubComposio() }));

    await act(async () => {
      await result.current.confirm(baseCard);
    });

    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "card_action",
      action: "confirm",
      intentCardId: "c1",
      intentKey: "work:review-pr",
      basket: "work",
      channel: "web",
    });
    expect(result.current.processingIds.has("c1")).toBe(true);
    expect(result.current.confirmedIds.has("c1")).toBe(true);
    expect(onOpenChat).toHaveBeenCalledWith(baseCard, "Draft a reply");
  });

  test("confirm: connector card starts OAuth, persists complete, and skips chat", async () => {
    const onOpenChat = vi.fn();
    const composio = stubComposio();
    const connectorCard: IntentCard = {
      ...baseCard,
      id: "connect-card",
      intentKey: "connect:google_calendar",
      title: "Connect Calendar",
      primaryAction: { label: "Connect Calendar", type: "confirm" },
    };
    const { result } = renderHook(() => useCardActions({ onOpenChat, composio }));

    await act(async () => {
      await result.current.confirm(connectorCard);
    });

    expect(composio.connectToolkit).toHaveBeenCalledWith("googlecalendar");
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "card_action",
      action: "complete",
      intentCardId: "connect-card",
      intentKey: "connect:google_calendar",
      basket: "work",
      channel: "web",
    });
    expect(result.current.confirmedIds.has("connect-card")).toBe(true);
    expect(result.current.doneIds.has("connect-card")).toBe(true);
    expect(result.current.processingIds.has("connect-card")).toBe(false);
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  test("confirm: connector card stays processing while OAuth is preparing", async () => {
    const onOpenChat = vi.fn();
    let resolveConnect!: (value: { ok: true }) => void;
    const connectPromise = new Promise<{ ok: true }>((resolve) => {
      resolveConnect = resolve;
    });
    const composio = {
      ...stubComposio(),
      connectToolkit: vi.fn(() => connectPromise),
    };
    const connectorCard: IntentCard = {
      ...baseCard,
      id: "connect-card",
      intentKey: "connect:gmail",
      title: "Connect Gmail",
      primaryAction: { label: "Connect Gmail", type: "confirm" },
    };
    const { result } = renderHook(() => useCardActions({ onOpenChat, composio }));

    let confirmPromise!: Promise<void>;
    act(() => {
      confirmPromise = result.current.confirm(connectorCard);
    });

    await waitFor(() => {
      expect(result.current.processingIds.has("connect-card")).toBe(true);
    });
    expect(result.current.doneIds.has("connect-card")).toBe(false);
    expect(proxyPost).not.toHaveBeenCalledWith("/feedback", expect.objectContaining({
      action: "complete",
      intentCardId: "connect-card",
    }));

    await act(async () => {
      resolveConnect({ ok: true });
      await confirmPromise;
    });

    expect(result.current.processingIds.has("connect-card")).toBe(false);
    expect(result.current.doneIds.has("connect-card")).toBe(true);
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  test("confirm: connector card failure does not complete or open chat", async () => {
    const onOpenChat = vi.fn();
    const composio = {
      ...stubComposio(),
      connectToolkit: vi.fn(async () => ({ ok: false, error: "No redirect URL returned" })),
    };
    const connectorCard: IntentCard = {
      ...baseCard,
      id: "connect-card",
      intentKey: "connect:gmail",
      title: "Connect Gmail",
      primaryAction: { label: "Connect Gmail", type: "confirm" },
    };
    const { result } = renderHook(() => useCardActions({ onOpenChat, composio }));

    await act(async () => {
      await result.current.confirm(connectorCard);
    });

    expect(composio.connectToolkit).toHaveBeenCalledWith("gmail");
    expect(proxyPost).not.toHaveBeenCalledWith("/feedback", expect.objectContaining({
      action: "complete",
      intentCardId: "connect-card",
    }));
    expect(result.current.confirmedIds.has("connect-card")).toBe(false);
    expect(result.current.processingIds.has("connect-card")).toBe(false);
    expect(result.current.doneIds.has("connect-card")).toBe(false);
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  test("dismiss: posts kind=dismiss and adds to dismissedIds", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await act(async () => {
      await result.current.dismiss(baseCard);
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "dismiss",
      intentCardId: "c1",
      intentKey: "work:review-pr",
      basket: "work",
      channel: "web",
    });
    expect(result.current.dismissedIds.has("c1")).toBe(true);
  });

  test("snooze: posts kind=snooze and hides via dismissedIds", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await act(async () => {
      await result.current.snooze(baseCard);
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "snooze",
      intentCardId: "c1",
      intentKey: "work:review-pr",
      basket: "work",
      channel: "web",
    });
    expect(result.current.dismissedIds.has("c1")).toBe(true);
  });

  test("modify: posts card_action modify and opens chat with Steer bootstrap", async () => {
    const onOpenChat = vi.fn();
    const { result } = renderHook(() => useCardActions({ onOpenChat, composio: stubComposio() }));
    await act(async () => {
      await result.current.modify(baseCard);
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "card_action",
      action: "modify",
      intentCardId: "c1",
      intentKey: "work:review-pr",
      basket: "work",
      channel: "web",
    });
    // Steer bootstrap is non-empty by design — the card_execution agent
    // needs an explicit "ask me before acting" instruction.
    const [card, bootstrap] = onOpenChat.mock.calls[0]!;
    expect(card).toBe(baseCard);
    expect(bootstrap).toMatch(/steer/i);
    expect(bootstrap).toContain("Draft a reply");
    expect(result.current.processingIds.has("c1")).toBe(true);
  });

  test("complete: posts card_action complete and moves processing → done", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await act(async () => {
      await result.current.confirm(baseCard); // seed processing
    });
    expect(result.current.processingIds.has("c1")).toBe(true);
    await act(async () => {
      await result.current.complete(baseCard);
    });
    expect(proxyPost).toHaveBeenLastCalledWith("/feedback", {
      kind: "card_action",
      action: "complete",
      intentCardId: "c1",
      intentKey: "work:review-pr",
      basket: "work",
      channel: "web",
    });
    expect(result.current.doneIds.has("c1")).toBe(true);
    expect(result.current.processingIds.has("c1")).toBe(false);
  });

  test("complete: waits for feedback persistence before moving processing → done", async () => {
    let resolveComplete: ((value: Response) => void) | null = null;
    const completePosted = new Promise<Response>((resolve) => {
      resolveComplete = resolve;
    });
    (proxyPost as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, body: { action?: string }) => {
        if (body.action === "complete") return completePosted;
        return new Response("{}", { status: 200 });
      },
    );

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await act(async () => {
      await result.current.confirm(baseCard);
    });

    let completePromise!: Promise<boolean>;
    act(() => {
      completePromise = result.current.complete(baseCard);
    });

    expect(result.current.doneIds.has("c1")).toBe(false);
    expect(result.current.processingIds.has("c1")).toBe(true);

    await act(async () => {
      resolveComplete?.(new Response("{}", { status: 200 }));
      await completePromise;
    });

    expect(result.current.doneIds.has("c1")).toBe(true);
    expect(result.current.processingIds.has("c1")).toBe(false);
  });

  test("complete: clears spinner but does not mark done when feedback persistence fails", async () => {
    // Two invariants live in this test, separated on purpose:
    //   - `doneIds` stays in sync with the server: we ONLY claim
    //     completion when the POST succeeded. (This is the
    //     `fix(card-actions): sync completion state` invariant
    //     from commit d2672ba3.)
    //   - `processingIds` must drop on failure too — the user
    //     has tapped the terminal "Done" action, so the
    //     "Processing…" spinner that ChatTimeline / sphere render
    //     should come off whether or not the server got the
    //     message. Without this, a transient blip leaves the
    //     card spinning on the sphere with no visible feedback
    //     to the user (handleConfirmDone's `if (persisted ===
    //     false) return;` early-out swallows the failure UI-side).
    (proxyPost as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, body: { action?: string }) => {
        if (body.action === "complete") return new Response("{}", { status: 500 });
        return new Response("{}", { status: 200 });
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await act(async () => {
      await result.current.confirm(baseCard);
    });
    expect(result.current.processingIds.has("c1")).toBe(true);

    let persisted: boolean | undefined;
    await act(async () => {
      persisted = await result.current.complete(baseCard);
    });

    expect(persisted).toBe(false);
    expect(result.current.doneIds.has("c1")).toBe(false);
    expect(result.current.processingIds.has("c1")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("textFeedback: posts trimmed text; ignores empty/whitespace", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }));
    await act(async () => {
      await result.current.textFeedback(baseCard, "   ");
    });
    expect(proxyPost).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.textFeedback(baseCard, "  too eager  ");
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "text_feedback",
      intentCardId: "c1",
      intentKey: "work:review-pr",
      basket: "work",
      channel: "web",
      text: "too eager",
    });
  });

  test("chattedIds persists to sessionStorage across mounts", async () => {
    const { result, unmount } = renderHook(() =>
      useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }),
    );
    await act(async () => {
      await result.current.confirm(baseCard);
    });
    expect(result.current.chattedIds.has("c1")).toBe(true);
    unmount();

    const { result: result2 } = renderHook(() =>
      useCardActions({ onOpenChat: vi.fn(), composio: stubComposio() }),
    );
    expect(result2.current.chattedIds.has("c1")).toBe(true);
  });
});
