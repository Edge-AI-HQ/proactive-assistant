/**
 * 卡片动作编排（confirm / steer / snooze / dismiss / complete / chat）——web
 * `packages/ui-web/src/card/useCardActions.ts` 的 RN 对应物。**单实例**：由
 * CardActionsProvider 在壳级持有一份，NOW 球面与 TASKS 列表经 context 消费
 * （web AppLayout 同位）——五个乐观 id 集合（processing/done/confirmed/
 * dismissed/chatted）两屏共享、mount-restore 只跑一次。
 *
 * `/feedback` POST 的 body 形态走 core card-actions 协议（纯契约），本 hook
 * 只做平台编排：haptics + best-effort POST（失败落本地 outbox 重传）+
 * confirm/steer 跳转 card chat（带 bootstrap 首条指令）。web 的 chattedIds
 * 持久化在 sessionStorage（tab 会话级）；RN 无 sessionStorage，内存 Set 的
 * 生命周期 = provider 挂载期 ≈ app 会话，语义等价。
 */
import { useCallback, useEffect, useState } from "react";
import {
  canonicalConnectorSlugFromIntentKey,
  cardActionFeedbackBody,
  confirmBootstrap,
  dismissFeedbackBody,
  proxyFetch,
  proxyPost,
  snoozeFeedbackBody,
  steerBootstrap,
  type IntentCard,
} from "@pin-ai/core";
import type { ComposioState } from "@pin-ai/state";
import * as Haptics from "expo-haptics";

import {
  openPreparedConnectorOAuth,
  prepareConnectorOAuth,
} from "../components/connect/card-connector-oauth";
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
  /** 壳级共享的 useComposio 实例（web 同注释：调用方注入而非本 hook 自建，
   *  避免每个消费者各起一份 /composio/status 轮询）。confirm 的 connect:*
   *  短路分支用它换 OAuth redirectUrl。 */
  composio: ComposioState;
}

export interface CardActions {
  processingIds: Set<string>;
  doneIds: Set<string>;
  confirmedIds: Set<string>;
  dismissedIds: Set<string>;
  chattedIds: Set<string>;
  confirm: (card: IntentCard) => Promise<void>;
  steer: (card: IntentCard) => void;
  snooze: (card: IntentCard) => void;
  dismiss: (card: IntentCard) => void;
  complete: (card: IntentCard) => void;
  chat: (card: IntentCard) => void;
}

export function useCardActions({ onOpenChat, composio }: CardActionsConfig): CardActions {
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [chattedIds, setChattedIds] = useState<Set<string>>(new Set());

  // mount-restore（web useCardActions 同款）：从后端拉「已 dismiss / 已 complete」
  // 的卡 id 合并进本地集合。不做的话 app 重启后集合清空 → 已退场的卡重现星云
  // （web 注释原话：resolved cards reappear on the sphere until re-clicking）。
  // merge 而非 replace：init 返回前用户可能已经乐观 dismiss 过几张。
  useEffect(() => {
    let abort = false;
    void (async () => {
      const [dismissedRes, completedRes] = await Promise.allSettled([
        proxyFetch("/feedback/dismissed"),
        proxyFetch("/feedback/completed"),
      ]);
      if (abort) return;
      if (dismissedRes.status === "fulfilled" && dismissedRes.value.ok) {
        try {
          const data = (await dismissedRes.value.json()) as {
            ok?: boolean;
            dismissedCardIds?: string[];
          };
          if (!abort && data?.ok && Array.isArray(data.dismissedCardIds)) {
            setDismissedIds((prev) => {
              const next = new Set(prev);
              for (const id of data.dismissedCardIds!) next.add(id);
              return next;
            });
          }
        } catch {
          /* dismissed 恢复失败只影响一次启动 */
        }
      }
      if (completedRes.status === "fulfilled" && completedRes.value.ok) {
        try {
          const data = (await completedRes.value.json()) as {
            ok?: boolean;
            completedCardIds?: string[];
          };
          if (!abort && data?.ok && Array.isArray(data.completedCardIds)) {
            setDoneIds((prev) => {
              const next = new Set(prev);
              for (const id of data.completedCardIds!) next.add(id);
              return next;
            });
          }
        } catch {
          /* completed 恢复失败只影响一次启动 */
        }
      }
    })();
    return () => {
      abort = true;
    };
  }, []);

  const markChatted = useCallback((id: string) => {
    setChattedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const confirm = useCallback(
    async (card: IntentCard) => {
      const cardId = card.id;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setConfirmedIds((s) => new Set(s).add(cardId));

      // Connector-guidance card（intent_key="connect:<slug>"）短路（web
      // useCardActions:154-185 同构）：Composio 备好 redirect URL 期间挂本地
      // pending 态，随后标 complete 退场。不进 chat——连接流程在授权面里，
      // 不在会话里。
      const canonicalConnectorSlug = canonicalConnectorSlugFromIntentKey(card.intentKey);
      if (canonicalConnectorSlug) {
        setProcessingIds((s) => new Set(s).add(cardId));
        const preparedOAuth = await prepareConnectorOAuth(canonicalConnectorSlug, composio);
        if (!preparedOAuth) {
          setProcessingIds((s) => {
            const n = new Set(s);
            n.delete(cardId);
            return n;
          });
          setConfirmedIds((s) => {
            const n = new Set(s);
            n.delete(cardId);
            return n;
          });
          return;
        }
        await postCardFeedback(cardActionFeedbackBody("complete", card), `fb:complete:${cardId}`);
        await openPreparedConnectorOAuth(preparedOAuth, { awaitClose: false });
        setProcessingIds((s) => {
          const n = new Set(s);
          n.delete(cardId);
          return n;
        });
        setDoneIds((s) => new Set(s).add(cardId));
        return;
      }

      setProcessingIds((s) => new Set(s).add(cardId));
      markChatted(cardId);
      void postCardFeedback(cardActionFeedbackBody("confirm", card), `fb:confirm:${cardId}`);
      onOpenChat(card, confirmBootstrap(card));
    },
    [composio, onOpenChat, markChatted],
  );

  const steer = useCallback(
    (card: IntentCard) => {
      setProcessingIds((s) => new Set(s).add(card.id));
      markChatted(card.id);
      void postCardFeedback(cardActionFeedbackBody("modify", card), `fb:modify:${card.id}`);
      onOpenChat(card, steerBootstrap(card));
    },
    [onOpenChat, markChatted],
  );

  const snooze = useCallback((card: IntentCard) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDismissedIds((s) => new Set(s).add(card.id));
    void postCardFeedback(snoozeFeedbackBody(card), `fb:snooze:${card.id}`);
  }, []);

  const dismiss = useCallback((card: IntentCard) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDismissedIds((s) => new Set(s).add(card.id));
    void postCardFeedback(dismissFeedbackBody(card), `fb:dismiss:${card.id}`);
  }, []);

  // Done = acknowledge + retire（web CardDrawerContent onComplete）。乐观退场
  // （doneIds 立即入集）是 RN 既定语义——web 等 POST 成功才入集（drawer complete
  // 乐观语义差异已拍板 OK）。
  const complete = useCallback((card: IntentCard) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setDoneIds((s) => new Set(s).add(card.id));
    setProcessingIds((s) => {
      if (!s.has(card.id)) return s;
      const n = new Set(s);
      n.delete(card.id);
      return n;
    });
    void postCardFeedback(cardActionFeedbackBody("complete", card), `fb:complete:${card.id}`);
  }, []);

  // Chat = 纯开 card chat（web reminder 卡的主操作，无 execute bootstrap）。
  // 标 chatted：timeline 显示 "In conversation" 并回路由到该 thread（web
  // AppLayout onChat 同注释）。
  const chat = useCallback(
    (card: IntentCard) => {
      markChatted(card.id);
      onOpenChat(card, "");
    },
    [onOpenChat, markChatted],
  );

  return {
    processingIds,
    doneIds,
    confirmedIds,
    dismissedIds,
    chattedIds,
    confirm,
    steer,
    snooze,
    dismiss,
    complete,
    chat,
  };
}
