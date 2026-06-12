import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { UseCardsQueryResult } from "@pin-ai/state";
import type { IntentCard } from "@pin-ai/core";
import {
  CardStateProvider,
  type CardActions,
  type CardStateValue,
} from "@/components/card/CardStateContext";
import CardTimeline from "./CardTimeline";

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

const noop = vi.fn();

// cardsState + cardActions arrive via CardStateContext, not props.
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
  } as unknown as UseCardsQueryResult,
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
  test("opens card detail through the shared parent drawer (onOpenCardDetail)", () => {
    const onOpenCardDetail = vi.fn();

    render(
      <CardStateProvider value={mockCardState}>
        <CardTimeline onOpenChat={noop} onOpenCardDetail={onOpenCardDetail} />
      </CardStateProvider>,
    );

    fireEvent.click(screen.getByText("Timeline Card"));

    expect(onOpenCardDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: card.id, title: card.title }),
    );
  });
});
