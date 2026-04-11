import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiPost } = vi.hoisted(() => ({
  apiPost: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock("@/lib/api", () => ({
  apiPost,
}));

import NowFeed from "./NowFeed";

describe("NowFeed feedback logging", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    apiPost.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("logs existing card interactions with run metadata", async () => {
    const onExecute = vi.fn();
    const onOpenChat = vi.fn();

    await act(async () => {
      root.render(
        <NowFeed
          cards={[
            {
              id: "card_1_1",
              goalBasket: "work",
              title: "Review queue with Alex",
              whyNow: "Two PRs are blocked today",
              summary: "Alex is waiting on your review before noon.",
              primaryAction: { label: "Review now", type: "confirm" },
              secondaryActions: [
                { label: "Modify", type: "modify" },
                { label: "Remind me later", type: "snooze" },
                { label: "Dismiss", type: "dismiss" },
              ],
              confidence: 0.9,
              urgency: 0.85,
              importance: 0.88,
              sources: ["calendar"],
              agentChain: ["planner", "generator"],
              createdAt: "2026-04-07",
            },
          ]}
          scoreMap={{}}
          isRunning={false}
          activePhase={null}
          onExecute={onExecute}
          onOpenChat={onOpenChat}
          runId="run_123"
        />,
      );
    });

    const title = Array.from(container.querySelectorAll("h3")).find(
      (node) => node.textContent === "Review queue with Alex",
    );
    expect(title).toBeTruthy();

    await act(async () => {
      title?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      title?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const chatButton = container.querySelector('button[title="Chat"]');
    expect(chatButton).toBeTruthy();

    await act(async () => {
      chatButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const modifyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Modify"),
    );
    const confirmButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Confirm"),
    );
    const dismissButton = container.querySelector('button[aria-label="Dismiss card"]');

    expect(modifyButton).toBeTruthy();
    expect(confirmButton).toBeTruthy();
    expect(dismissButton).toBeTruthy();

    await act(async () => {
      modifyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      dismissButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiPost).toHaveBeenCalledTimes(5);
    expect(apiPost).toHaveBeenNthCalledWith(1, "/api/feedback", {
      kind: "card_open",
      intentCardId: "card_1_1",
      basket: "work",
      channel: "web",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
    });
    expect(apiPost).toHaveBeenNthCalledWith(2, "/api/feedback", {
      kind: "card_action",
      action: "open_detail",
      intentCardId: "card_1_1",
      basket: "work",
      channel: "web",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
    });
    expect(apiPost).toHaveBeenNthCalledWith(3, "/api/feedback", {
      kind: "card_action",
      action: "modify",
      intentCardId: "card_1_1",
      basket: "work",
      channel: "web",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
    });
    expect(apiPost).toHaveBeenNthCalledWith(4, "/api/feedback", {
      kind: "card_action",
      action: "confirm",
      intentCardId: "card_1_1",
      basket: "work",
      channel: "web",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
    });
    expect(apiPost).toHaveBeenNthCalledWith(5, "/api/feedback", {
      kind: "dismiss",
      intentCardId: "card_1_1",
      basket: "work",
      channel: "web",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
    });
    expect(onOpenChat).toHaveBeenCalledWith("card_1_1");
    expect(onExecute).toHaveBeenCalledWith("Review queue with Alex");
  });

  it("logs Chinese titles with a non-empty unicode-safe intent key", async () => {
    await act(async () => {
      root.render(
        <NowFeed
          cards={[
            {
              id: "card_cn_1",
              goalBasket: "work",
              title: "买房首付规划",
              whyNow: "最近在看房，贷款窗口也合适。",
              summary: "先把首付节奏和现金流计划列出来。",
              primaryAction: { label: "开始规划", type: "confirm" },
              secondaryActions: [
                { label: "Modify", type: "modify" },
                { label: "Later", type: "snooze" },
                { label: "Dismiss", type: "dismiss" },
              ],
              confidence: 0.84,
              urgency: 0.81,
              importance: 0.9,
              sources: ["notes"],
              agentChain: ["planner", "generator"],
              createdAt: "2026-04-11",
            },
          ]}
          scoreMap={{}}
          isRunning={false}
          activePhase={null}
          onExecute={vi.fn()}
          onOpenChat={vi.fn()}
        />,
      );
    });

    const title = Array.from(container.querySelectorAll("h3")).find(
      (node) => node.textContent === "买房首付规划",
    );
    expect(title).toBeTruthy();

    await act(async () => {
      title?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiPost).toHaveBeenCalledWith("/api/feedback", {
      kind: "card_open",
      intentCardId: "card_cn_1",
      basket: "work",
      channel: "web",
      metadata: {
        intentKey: "work:买房首付规划",
        surface: "now_feed",
      },
    });
  });
});
