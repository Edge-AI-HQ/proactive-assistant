import {
  Sprout,
  Briefcase,
  TrendingUp,
  Heart,
  BookOpen,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  djb2,
  basketToLovableCategory,
  isReminderCard,
  REMINDER_CARD_KIND,
  type IntentCard,
} from "@pin-ai/core";
import type { ChatCard } from "../card/chat-card-presentation";
import i18n from "../i18n";

// 卡片数据模型 + 纯投影(djb2 / basketToLovableCategory / Intent / DetailData /
// CardStatus / realCardToLovableIntent)已下沉 @pin-ai/core(domain/lovable-card),
// web 与 RN 共用。这里只保留 web 介质绑定:ChatCard(drawer 契约)投影 + lucide 图标。
export { djb2, basketToLovableCategory };
export {
  realCardToLovableIntent,
  type Intent,
  type CardStatus,
  type DetailData,
} from "@pin-ai/core";

/** Real IntentCard (from /api/cards) → ChatDetailView's ChatCard shape
 *  (Lovable-era visual contract: numeric ids + the same `detail` envelope).
 *  Only the fields ChatDetailView actually reads are populated; the real
 *  EXECUTION PLAN / drafts / dangerous_actions / risks come from the cached
 *  propose_action args via the hook, not from this static projection. The
 *  original string id rides separately via the `runId` prop so the hook can
 *  derive the chat-stream session_key. */
export function realIntentToChatCard(card: IntentCard): ChatCard {
  return {
    id: djb2(card.id),
    category: basketToLovableCategory(card.goalBasket),
    tag: card.urgency >= 0.85 ? i18n.t("card:tag.urgent") : undefined,
    // Derive (not just copy) the kind: legacy reminder cards predate the
    // cardKind field and are only recognizable by their card-rem- id — the
    // string id is lost past this projection (ChatCard.id is numeric), so
    // this is the last place the fallback can apply. Without it the drawer
    // and the chat agent would disagree about what kind of card this is.
    ...(isReminderCard(card)
      ? { cardKind: REMINDER_CARD_KIND }
      : card.cardKind
        ? { cardKind: card.cardKind }
        : {}),
    ...(card.scheduleTaskId ? { scheduleTaskId: card.scheduleTaskId } : {}),
    title: card.title,
    line1: card.whyNow || card.summary,
    line2:
      card.sourceKind === "scheduled" && card.sourceLabel
        ? i18n.t("card:scheduledSource", { label: card.sourceLabel })
        : "",
    whyNow:
      card.whyNow && card.whyNow.trim() && card.whyNow !== card.summary
        ? card.whyNow
        : undefined,
    sourceApps: card.sourceApps,
    reasoningSteps: card.reasoningSteps,
    detail: {
      scores: [
        { label: i18n.t("card:score.confidence"), value: Math.round(card.confidence * 100) },
        { label: i18n.t("card:score.importance"), value: Math.round(card.importance * 100) },
        { label: i18n.t("card:score.urgency"), value: Math.round(card.urgency * 100) },
      ],
      willExecute: card.primaryAction?.label ?? "",
      executionPlan: [],
      dataSources: card.sources,
      impact: "",
      permissions: "",
    },
  };
}

export const CATEGORIES: Record<string, { icon: LucideIcon }> = {
  growth:  { icon: Sprout },
  work:    { icon: Briefcase },
  finance: { icon: TrendingUp },
  health:  { icon: Heart },
  learn:   { icon: BookOpen },
  life:    { icon: Sparkles },
};

const CATEGORY_LABEL_KEYS = {
  growth: "card:category.growth",
  work: "card:category.work",
  finance: "card:category.finance",
  health: "card:category.health",
  learn: "card:category.learn",
  life: "card:category.life",
} as const;

function isKnownCategory(c: string): c is keyof typeof CATEGORY_LABEL_KEYS {
  return c in CATEGORY_LABEL_KEYS;
}

/** Category display label, resolved through i18n at call time. Unknown
 *  categories fall back to the Title-Cased slug (backend identifier). */
export function categoryLabel(category: string): string {
  if (isKnownCategory(category)) return i18n.t(CATEGORY_LABEL_KEYS[category]);
  return category.charAt(0).toUpperCase() + category.slice(1);
}
