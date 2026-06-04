import { createContext, useContext, type ReactNode } from "react";
import type { UseCardsState } from "@/hooks/useCards";
import { useCardActions } from "@/hooks/useCardActions";

export type CardActions = ReturnType<typeof useCardActions>;

export interface CardStateValue {
  cardsState: UseCardsState;
  cardActions: CardActions;
}

const CardStateContext = createContext<CardStateValue | null>(null);

/**
 * Card data (useCards) + actions (useCardActions) shared with deep
 * descendants (the Tasks timeline) without prop-drilling. ConstellationLayout
 * still owns the hooks; this just exposes their result through context so
 * ChatTimeline doesn't need 11 individual props threaded through.
 */
export function useCardState(): CardStateValue {
  const ctx = useContext(CardStateContext);
  if (!ctx) {
    throw new Error("useCardState must be used inside <CardStateProvider>");
  }
  return ctx;
}

export function CardStateProvider({
  value,
  children,
}: {
  value: CardStateValue;
  children: ReactNode;
}) {
  return (
    <CardStateContext.Provider value={value}>
      {children}
    </CardStateContext.Provider>
  );
}
