import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { ComposioState } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

vi.mock("@/components/ui/drawer", async () => {
  const React = await import("react");
  const Div = ({ children, ...props }: MockElementProps) => {
    const { open, onOpenChange, overlayClassName, ...domProps } = props;
    void open;
    void onOpenChange;
    void overlayClassName;
    return React.createElement("div", domProps, children);
  };

  return {
    Drawer: Div,
    DrawerContent: Div,
    DrawerDescription: Div,
    DrawerHeader: Div,
    DrawerTitle: Div,
  };
});

vi.mock("./CardDetailBody", () => ({
  default: () => <div>Legacy timeline drawer</div>,
}));

vi.mock("@/lib/api", () => ({
  proxyPost: vi.fn(async () => new Response("{}", { status: 200 })),
}));

const card: IntentCard = {
  id: "card-1",
  goalBasket: "work",
  title: "Timeline Card",
  whyNow: "Now",
  summary: "Summary",
  primaryAction: { label: "Do it", type: "confirm" },
  secondaryActions: [],
  confidence: 0.9,
  urgency: 0.8,
  importance: 0.7,
  sources: [],
  agentChain: [],
  createdAt: "2026-05-18T19:00:00Z",
};

import ChatTimeline from "./ChatTimeline";

// Minimal ComposioState stub. The connect:* short-circuit never fires
// in these tests because `card.intentKey` is undefined.
const stubComposio: ComposioState = {
  keyStatus: { configured: false },
  connections: [],
  statusLoading: false,
  loadingConns: false,
  loadStatus: vi.fn(async () => undefined),
  loadConnections: vi.fn(async () => []),
  connectToolkit: vi.fn(async () => ({ ok: true })),
  disconnectAccount: vi.fn(async () => ({ ok: true })),
  waitForToolkit: vi.fn(async () => ({ connected: true })),
  cancelWait: vi.fn(),
  isToolkitConnected: vi.fn(() => false),
  reconnectAccount: vi.fn(async () => ({ ok: true })),
};

const noop = vi.fn();
const baseProps = {
  cards: {
    cards: [{
      card,
      runId: "run-1",
      runCompletedAt: "2026-05-18T19:00:00Z",
      score: null,
      latestOutcome: null,
      outcomeAt: null,
    }],
    loading: false,
    error: null,
  },
  onOpenChat: noop,
  dismissedIds: new Set<string>(),
  confirmedIds: new Set<string>(),
  processingIds: new Set<string>(),
  doneIds: new Set<string>(),
  chattedIds: new Set<string>(),
  onDismissId: noop,
  onConfirmId: noop,
  onDoneId: noop,
  onProcessingId: noop,
  onChattedId: noop,
  composio: stubComposio,
};

describe("ChatTimeline card detail routing", () => {
  test("delegates card detail opens to the shared parent drawer when provided", () => {
    const onOpenCardDetail = vi.fn();

    render(
      <ChatTimeline
        {...baseProps}
        onOpenCardDetail={onOpenCardDetail}
      />,
    );

    fireEvent.click(screen.getByText("Timeline Card"));

    expect(onOpenCardDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: card.id, title: card.title }),
    );
    expect(screen.queryByText("Legacy timeline drawer")).toBeNull();
  });
});
