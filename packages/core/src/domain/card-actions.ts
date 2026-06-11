/**
 * Card action feedback 协议（纯 TS）—— 分层 Phase 3 从
 * proactive-ai-frontend hooks/useCardActions.ts 提纯。
 *
 * **所有 `/feedback` POST 的 payload 形态是协议契约**（`kind` 维度分
 * `card_action` / `dismiss` / `snooze` / `text_feedback`；`intentCardId` +
 * `basket` + `channel: "web"`），由 card-actions.test.ts 锁定，不动协议。
 * OAuth 短路、乐观 Set 状态等编排留在 app 的 hooks/useCardActions.ts。
 */
import type { IntentCard } from "./intent-card";

export type CardActionKind = "confirm" | "modify" | "complete";

export function cardActionFeedbackBody(
  action: CardActionKind,
  card: IntentCard,
): Record<string, unknown> {
  return {
    kind: "card_action",
    action,
    intentCardId: card.id,
    intentKey: card.intentKey,
    basket: card.goalBasket,
    channel: "web",
  };
}

export function dismissFeedbackBody(card: IntentCard): Record<string, unknown> {
  return {
    kind: "dismiss",
    intentCardId: card.id,
    intentKey: card.intentKey,
    basket: card.goalBasket,
    channel: "web",
  };
}

export function snoozeFeedbackBody(card: IntentCard): Record<string, unknown> {
  return {
    kind: "snooze",
    intentCardId: card.id,
    intentKey: card.intentKey,
    basket: card.goalBasket,
    channel: "web",
  };
}

export function textFeedbackBody(
  card: IntentCard,
  text: string,
): Record<string, unknown> {
  return {
    kind: "text_feedback",
    intentCardId: card.id,
    intentKey: card.intentKey,
    basket: card.goalBasket,
    channel: "web",
    text,
  };
}

/** Confirm 的 chat bootstrap：prefer the agent task spec (agentPrompt)
 *  over the short button label. Older cards lack agentPrompt → fall back
 *  to label / title. */
export function confirmBootstrap(card: IntentCard): string {
  return (
    card.primaryAction?.agentPrompt
      || card.primaryAction?.label
      || card.title
      || ""
  ).trim();
}

/** Modify (Steer) 的 chat bootstrap：tell the card_execution agent the
 *  user wants to adjust direction BEFORE acting —— 保留旧 "modify means
 *  ask me before acting" 的业务语义。 */
export function steerBootstrap(card: IntentCard): string {
  const originalPlan = card.primaryAction?.label?.trim() || card.title.trim();
  return originalPlan
    ? `I want to steer this before you act. Original plan: ${originalPlan}. Ask me how I'd like to adjust it (recipient, tone, scope, timing, anything else) and wait for my reply before executing.`
    : "I want to steer this card before you act. Ask me how I'd like to adjust it and wait for my reply before executing.";
}
