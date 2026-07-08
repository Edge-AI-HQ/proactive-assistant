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
import { createContext, useContext, useMemo, type ReactNode } from "react";
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
  // value memo 化（切页卡顿修复）：Provider 是壳级组件，AppShell 任何状态变更
  // （开关抽屉/切页/开 chat）都会重渲到这里；value 若每次新建，所有 context 消费者
  // （TASKS 每一行、NOW 球面、CardDetailSheet）会被连坐重渲——这正是点击菜单
  // 瞬间 JS 卡一拍的主因之一。actions/composio 已各自 memo 化，集合真变时
  // value 依旧照常更新消费者。
  const value: CardActionsContextValue = useMemo(
    () => ({ ...actions, composio }),
    [actions, composio],
  );
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
