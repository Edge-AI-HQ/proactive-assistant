/**
 * 卡片动作编排（confirm / steer / snooze / dismiss）——NOW 球面与 TASKS 列表
 * 共用。`/feedback` POST 的 body 形态走 core card-actions 协议（纯契约），本
 * hook 只做平台编排：haptics + best-effort POST（失败落本地 outbox 重传）+
 * 关闭详情面板 / 乐观隐藏 + confirm/steer 跳转 card chat（带 bootstrap 首条
 * 指令）。从 NowScreen 原内联实现提纯，两屏唯一真源。
 */
import {
  cardActionFeedbackBody,
  confirmBootstrap,
  dismissFeedbackBody,
  proxyPost,
  snoozeFeedbackBody,
  steerBootstrap,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import * as Haptics from "expo-haptics";

import { enqueueFeedback } from "../lib/sync/sync-bootstrap";

/** best-effort POST /feedback；离线/失败落本地 outbox 重传。 */
export async function postCardFeedback(
  body: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  try {
    await proxyPost("/feedback", body);
  } catch {
    await enqueueFeedback(body, dedupeKey);
  }
}

export interface CardActionsConfig {
  /** 打开 card chat（confirm/steer 带 bootstrap 首条指令；空串 = 纯打开）。 */
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  /** 乐观移除卡片（snooze/dismiss 后）。历史列表传 noop——靠下次轮询翻成
   *  resolved（strikethrough），不立即移除。 */
  onHide: (id: string) => void;
  /** 「用户碰过这张卡」的乐观标记（NOW 球面驱动 run 徽章；列表不需要可省）。 */
  onEngage?: (id: string) => void;
  /** 动作发出后关闭详情面板。 */
  onClose: () => void;
}

export function useCardActions({ onOpenChat, onHide, onEngage, onClose }: CardActionsConfig) {
  const confirm = (e: VisibleCardEntry) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onEngage?.(e.card.id);
    void postCardFeedback(cardActionFeedbackBody("confirm", e.card), `fb:confirm:${e.card.id}`);
    onClose();
    onOpenChat(e.card, confirmBootstrap(e.card));
  };
  const steer = (e: VisibleCardEntry) => {
    onEngage?.(e.card.id);
    void postCardFeedback(cardActionFeedbackBody("modify", e.card), `fb:modify:${e.card.id}`);
    onClose();
    onOpenChat(e.card, steerBootstrap(e.card));
  };
  const snooze = (e: VisibleCardEntry) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onHide(e.card.id);
    onClose();
    void postCardFeedback(snoozeFeedbackBody(e.card), `fb:snooze:${e.card.id}`);
  };
  const dismiss = (e: VisibleCardEntry) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onHide(e.card.id);
    onClose();
    void postCardFeedback(dismissFeedbackBody(e.card), `fb:dismiss:${e.card.id}`);
  };
  return { confirm, steer, snooze, dismiss };
}
