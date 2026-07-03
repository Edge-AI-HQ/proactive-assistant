/**
 * `<card_context>` payload for card chat —— 首条消息随 /send 送后端
 * (worker 注入 SystemMessage 给 agent)。纯投影,从 ui-web/card/card-chat.tsx
 * 上移共享(那边保留 web 介质版:ChatCard 类型 + header chip);本文件是
 * RN / 后续端消费的平台无关真源,输出字段与 ui-web buildCardContext 逐字一致。
 */

/** `detail` envelope 里 buildCardContext 关心的字段;其余(scores/executionPlan/
 *  dataSources/…)原样透传进 card_context。 */
export interface CardContextDetail {
  willExecute?: string;
  [key: string]: unknown;
}

/** buildCardContext 的输入投影(= ui-web ChatCard 中会进 card_context 的字段)。 */
export interface CardContextCard {
  title: string;
  category: string;
  tag?: string;
  /** Card type + owning schedule task: the agent's <reminder_cards> prompt
   *  branch keys on these (don't "execute" a nudge; edit the right task). */
  cardKind?: string;
  scheduleTaskId?: string;
  line1: string;
  whyNow?: string;
  sourceApps?: string[];
  detail?: CardContextDetail;
}

export function buildCardContext(card: CardContextCard): Record<string, unknown> {
  return {
    title: card.title,
    category: card.category,
    tag: card.tag,
    // Card type + owning schedule task: the agent's <reminder_cards> prompt
    // branch keys on these (don't "execute" a nudge; edit the right task).
    ...(card.cardKind ? { cardKind: card.cardKind } : {}),
    ...(card.scheduleTaskId ? { scheduleTaskId: card.scheduleTaskId } : {}),
    summary: card.line1,
    whyNow: card.whyNow ?? card.line1,
    sources: card.sourceApps ?? [],
    primaryAction: card.detail?.willExecute
      ? { label: card.detail.willExecute, type: "confirm" }
      : undefined,
    detail: card.detail,
  };
}
