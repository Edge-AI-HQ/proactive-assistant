/**
 * 壳级卡片动作单实例——web AppLayout `CardStateProvider`（CardStateContext）的
 * RN 对应物：useCardActions 只在这里实例化一次，NOW 球面 / TASKS 列表 /
 * CardDetailSheet 经 context 消费同一份乐观 id 集合（dismiss/done 立即两屏
 * 同步；mount-restore 的 /feedback/{dismissed,completed} 只拉一次）。
 *
 * wiring（AppShell）：
 *   <CardActionsProvider composio={composio}
 *     onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}>
 *     …MenuDrawerHost + sheets…
 *   </CardActionsProvider>
 * composio 复用 AppShell 已有的壳级 useComposio 实例（web 同位）。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { IntentCard } from "@pin-ai/core";
import type { ComposioState } from "@pin-ai/state";

import { useCardActions, type CardActions } from "../../hooks/useCardActions";

export interface CardActionsContextValue extends CardActions {
  /** 壳级共享 composio（NOW 空态的 connector 检查等顺带消费，免额外 prop）。 */
  composio: ComposioState;
}

const CardActionsContext = createContext<CardActionsContextValue | null>(null);

export function CardActionsProvider({
  composio,
  onOpenChat,
  children,
}: {
  composio: ComposioState;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  children: ReactNode;
}) {
  const actions = useCardActions({ onOpenChat, composio });
  // value 每 render 新建对象——与 web CardStateProvider 的 {{ cardsState, cardActions }}
  // 同款（集合变更本来就要触发消费者重渲染，无 memo 价值）。
  const value: CardActionsContextValue = { ...actions, composio };
  return <CardActionsContext.Provider value={value}>{children}</CardActionsContext.Provider>;
}

/** 强依赖版：NOW / TASKS 用。Provider 未挂载 = wiring 缺失，直接抛错暴露。 */
export function useCardActionsContext(): CardActionsContextValue {
  const ctx = useContext(CardActionsContext);
  if (!ctx) {
    throw new Error(
      "useCardActionsContext: CardActionsProvider is not mounted — wrap AppShell content with it.",
    );
  }
  return ctx;
}

/** 可选版：CardDetailSheet 用（CardChatScreen 等 Provider 外挂载点容忍缺失）。 */
export function useOptionalCardActions(): CardActionsContextValue | null {
  return useContext(CardActionsContext);
}
