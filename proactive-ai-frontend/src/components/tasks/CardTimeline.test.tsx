import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { ComposioState } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";
import {
  CardStateProvider,
  type CardActions,
  type CardStateValue,
} from "@/components/card/CardStateContext";
import type { UseCardsState } from "@/hooks/useCards";

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

vi.mock("@/components/CardDetailBody", () => ({
  default: ({ onConfirm }: { onConfirm: () => void }) => (
    <div>
      Legacy timeline drawer
      <button type="button" onClick={onConfirm}>Confirm mock</button>
    </div>
  ),
}));

vi.mock("@/lib/api", () => ({
  proxyPost: vi.fn(async () => new Response("{}", { status: 200 })),
}));

import { proxyPost } from "@/lib/api";

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

import CardTimeline from "./CardTimeline";

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

// cardsState + cardActions now arrive via CardStateContext instead of props.
const mockCardState: CardStateValue = {
  cardsState: {
    cards: [
      {
        card,
        runId: "run-1",
        runCompletedAt: "2026-05-18T19:00:00Z",
        score: null,
        latestOutcome: null,
        outcomeAt: null,
      },
    ],
    loading: false,
    error: null,
  } as unknown as UseCardsState,
  cardActions: {
    dismissedIds: new Set<string>(),
    confirmedIds: new Set<string>(),
    processingIds: new Set<string>(),
    doneIds: new Set<string>(),
    chattedIds: new Set<string>(),
    markDismissed: noop,
    markConfirmed: noop,
    markDone: noop,
    markProcessing: noop,
    markChatted: noop,
  } as unknown as CardActions,
};

describe("CardTimeline card detail routing", () => {
  test("delegates card detail opens to the shared parent drawer when provided", () => {
    const onOpenCardDetail = vi.fn();

    render(
      <CardStateProvider value={mockCardState}>
        <CardTimeline onOpenChat={noop} onOpenCardDetail={onOpenCardDetail} composio={stubComposio} />
      </CardStateProvider>,
    );

    fireEvent.click(screen.getByText("Timeline Card"));

    expect(onOpenCardDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: card.id, title: card.title }),
    );
    expect(screen.queryByText("Legacy timeline drawer")).toBeNull();
  });

  test("connector card confirm persists complete and does not open chat", async () => {
    const onOpenChat = vi.fn();
    const markDone = vi.fn();
    const composio: ComposioState = {
      ...stubComposio,
      connectToolkit: vi.fn(async () => ({ ok: true })),
    };
    const connectorCard: IntentCard = {
      ...card,
      id: "connector-card",
      intentKey: "connect:gmail",
      title: "Connect Gmail",
      primaryAction: { label: "Connect Gmail", type: "confirm" },
    };

    render(
      <CardStateProvider
        value={{
          cardsState: {
            cards: [{
              card: connectorCard,
              runId: "run-1",
              runCompletedAt: "2026-05-18T19:00:00Z",
              score: null,
              latestOutcome: null,
              outcomeAt: null,
            }],
            loading: false,
            error: null,
          } as unknown as UseCardsState,
          cardActions: {
            dismissedIds: new Set<string>(),
            confirmedIds: new Set<string>(),
            processingIds: new Set<string>(),
            doneIds: new Set<string>(),
            chattedIds: new Set<string>(),
            markDismissed: noop,
            markConfirmed: noop,
            markDone,
            markProcessing: noop,
            markChatted: noop,
          } as unknown as CardActions,
        }}
      >
        <CardTimeline composio={composio} onOpenChat={onOpenChat} />
      </CardStateProvider>,
    );

    fireEvent.click(screen.getByText("Connect Gmail"));
    fireEvent.click(screen.getByText("Confirm mock"));

    await waitFor(() => {
      expect(proxyPost).toHaveBeenCalledWith("/feedback", {
        kind: "card_action",
        action: "complete",
        intentCardId: "connector-card",
        intentKey: "connect:gmail",
        basket: "work",
        channel: "web",
      });
    });
    expect(composio.connectToolkit).toHaveBeenCalledWith("gmail");
    expect(markDone).toHaveBeenCalledWith("connector-card");
    expect(onOpenChat).not.toHaveBeenCalled();
  });
});
