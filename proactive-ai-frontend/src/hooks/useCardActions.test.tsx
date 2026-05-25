import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useCardActions } from "./useCardActions";
import type { IntentCard } from "@/types/intent-card";

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

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
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

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
    await waitFor(() => {
      expect(result.current.doneIds.has("c9")).toBe(true);
      expect(result.current.doneIds.has("c10")).toBe(true);
    });
    expect(proxyFetch).toHaveBeenCalledWith("/feedback/completed");
  });

  test("confirm: posts card_action + opens chat with primaryAction.label as bootstrap", async () => {
    const onOpenChat = vi.fn();
    const { result } = renderHook(() => useCardActions({ onOpenChat }));

    await act(async () => {
      await result.current.confirm(baseCard);
    });

    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "card_action",
      action: "confirm",
      intentCardId: "c1",
      basket: "work",
      channel: "web",
    });
    expect(result.current.processingIds.has("c1")).toBe(true);
    expect(result.current.confirmedIds.has("c1")).toBe(true);
    expect(onOpenChat).toHaveBeenCalledWith(baseCard, "Draft a reply");
  });

  test("dismiss: posts kind=dismiss and adds to dismissedIds", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
    await act(async () => {
      await result.current.dismiss(baseCard);
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "dismiss",
      intentCardId: "c1",
      basket: "work",
      channel: "web",
    });
    expect(result.current.dismissedIds.has("c1")).toBe(true);
  });

  test("snooze: posts kind=snooze and hides via dismissedIds", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
    await act(async () => {
      await result.current.snooze(baseCard);
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "snooze",
      intentCardId: "c1",
      basket: "work",
      channel: "web",
    });
    expect(result.current.dismissedIds.has("c1")).toBe(true);
  });

  test("modify: posts card_action modify and opens chat with Steer bootstrap", async () => {
    const onOpenChat = vi.fn();
    const { result } = renderHook(() => useCardActions({ onOpenChat }));
    await act(async () => {
      await result.current.modify(baseCard);
    });
    expect(proxyPost).toHaveBeenCalledWith("/feedback", {
      kind: "card_action",
      action: "modify",
      intentCardId: "c1",
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
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
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

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
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

  test("complete: keeps card processing when feedback persistence fails", async () => {
    (proxyPost as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, body: { action?: string }) => {
        if (body.action === "complete") return new Response("{}", { status: 500 });
        return new Response("{}", { status: 200 });
      },
    );

    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
    await act(async () => {
      await result.current.confirm(baseCard);
    });

    let persisted: boolean | undefined;
    await act(async () => {
      persisted = await result.current.complete(baseCard);
    });

    expect(persisted).toBe(false);
    expect(result.current.doneIds.has("c1")).toBe(false);
    expect(result.current.processingIds.has("c1")).toBe(true);
  });

  test("textFeedback: posts trimmed text; ignores empty/whitespace", async () => {
    const { result } = renderHook(() => useCardActions({ onOpenChat: vi.fn() }));
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
      basket: "work",
      channel: "web",
      text: "too eager",
    });
  });

  test("chattedIds persists to sessionStorage across mounts", async () => {
    const { result, unmount } = renderHook(() =>
      useCardActions({ onOpenChat: vi.fn() }),
    );
    await act(async () => {
      await result.current.confirm(baseCard);
    });
    expect(result.current.chattedIds.has("c1")).toBe(true);
    unmount();

    const { result: result2 } = renderHook(() =>
      useCardActions({ onOpenChat: vi.fn() }),
    );
    expect(result2.current.chattedIds.has("c1")).toBe(true);
  });
});
