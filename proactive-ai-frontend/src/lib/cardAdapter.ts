import type { GoalBasket, IntentCard } from "@/types/intent-card";
import type { CardCategory, CardStatus, Intent } from "@/types/constellation";

/**
 * djb2 — 把 string id 稳定 hash 成正整数，用作 Sphere3DCards 的 key。
 * 同一 string 永远得同一 number；不同 string 极少撞（碰撞了 sphere 也只是
 * 复用 key，不影响业务）。
 */
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return Math.abs(h | 0);
}

/**
 * GoalBasket → 视觉 CardCategory。
 * wealth → finance, family → life（Lovable 视觉系统里没有这两个 category，
 * 用最接近的视觉 fallback）；其余保持。
 */
function basketToCategory(basket: GoalBasket): CardCategory {
  switch (basket) {
    case "wealth":
      return "finance";
    case "family":
      return "life";
    case "work":
    case "health":
    case "growth":
    case "life":
      return basket;
    default:
      return "life";
  }
}

export interface AdapterOptions {
  status: CardStatus;
}

export function intentCardToIntent(card: IntentCard, opts: AdapterOptions): Intent {
  const line1 =
    card.whyNow && card.whyNow.trim().length > 0 ? card.whyNow : card.summary;
  const line2 =
    card.sources.length > 0 ? `Sources: ${card.sources.join(" · ")}` : "";
  const tag = card.urgency >= 0.85 ? "Urgent" : undefined;

  return {
    id: djb2(card.id),
    originalId: card.id,
    category: basketToCategory(card.goalBasket),
    tag,
    title: card.title,
    line1,
    line2,
    status: opts.status,
    detail: {
      scores: [
        { label: "Confidence", value: Math.round(card.confidence * 100) },
        { label: "Importance", value: Math.round(card.importance * 100) },
        { label: "Urgency", value: Math.round(card.urgency * 100) },
      ],
      willExecute: card.primaryAction.label,
      executionPlan: [],
      dataSources: card.sources,
      impact: "",
      permissions: "",
    },
  };
}

export interface BulkAdapterContext {
  processingIds: Set<string>;
  doneIds: Set<string>;
}

export function intentCardsToIntents(
  cards: IntentCard[],
  ctx: BulkAdapterContext,
): Intent[] {
  return cards.map((c) => {
    const status: CardStatus = ctx.processingIds.has(c.id)
      ? "processing"
      : ctx.doneIds.has(c.id)
        ? "done"
        : "normal";
    return intentCardToIntent(c, { status });
  });
}
