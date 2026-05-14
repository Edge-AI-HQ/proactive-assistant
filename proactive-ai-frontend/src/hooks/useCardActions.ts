import { useCallback, useEffect, useState } from "react";

import { proxyFetch, proxyPost } from "@/lib/api";
import type { IntentCard } from "@/types/intent-card";

const CHATTED_KEY = "proactive-ai:chattedCardIds";

function loadChatted(): Set<string> {
  try {
    const raw = sessionStorage.getItem(CHATTED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveChatted(ids: Set<string>) {
  try {
    sessionStorage.setItem(CHATTED_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore quota / SSR */
  }
}

export interface UseCardActionsOptions {
  /**
   * confirm 后回调：调用方负责切到 chat 视图并把 bootstrapMessage 当首条 user
   * turn 喂给 chat runtime（保持当前 AppShell 行为）。modify 路径也会触发，
   * 但 bootstrapMessage 是空串，表示"进 chat，等用户打字"。
   */
  onOpenChat: (card: IntentCard, bootstrapMessage: string) => void;
}

/**
 * 把 AppShell 里 confirm / dismiss / snooze / modify / complete / chat /
 * text_feedback 的副作用抽到一处，让 ConstellationLayout 复用。**所有
 * `/feedback` POST 的 payload 形态严格沿用 AppShell 现行实现**（`kind` 维度
 * 分 `card_action` / `dismiss` / `snooze` / `text_feedback`；`intentCardId` +
 * `basket` + `channel: "web"`），不动协议。
 */
export function useCardActions({ onOpenChat }: UseCardActionsOptions) {
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [chattedIds, setChattedIds] = useState<Set<string>>(() => loadChatted());

  useEffect(() => {
    let abort = false;
    (async () => {
      try {
        const res = await proxyFetch("/feedback/dismissed");
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; dismissedCardIds?: string[] };
        if (!abort && data?.ok && Array.isArray(data.dismissedCardIds)) {
          // Merge — 用户可能在 init 返回前已经 dismiss 过几张卡，整体替换
          // 会丢掉乐观更新（AppShell 历史上做的是 replace，这里改 merge 是
          // 顺手修正而不是行为变化，因为 init 总在 mount 后立刻发，用户极
          // 少有时间在它返回前先动手）。
          setDismissedIds((prev) => {
            const next = new Set(prev);
            for (const id of data.dismissedCardIds!) next.add(id);
            return next;
          });
        }
      } catch {
        /* swallow: dismissed init failure只影响一次启动 */
      }
    })();
    return () => {
      abort = true;
    };
  }, []);

  const persistChatted = useCallback((cardId: string) => {
    setChattedIds((prev) => {
      if (prev.has(cardId)) return prev;
      const next = new Set(prev);
      next.add(cardId);
      saveChatted(next);
      return next;
    });
  }, []);

  const confirm = useCallback(
    async (card: IntentCard) => {
      const cardId = card.id;
      setConfirmedIds((s) => new Set(s).add(cardId));
      setProcessingIds((s) => new Set(s).add(cardId));
      persistChatted(cardId);
      try {
        await proxyPost("/feedback", {
          kind: "card_action",
          action: "confirm",
          intentCardId: cardId,
          basket: card.goalBasket,
          channel: "web",
        });
      } catch {
        /* swallow; UI 已 optimistic */
      }
      const bootstrap =
        (card.primaryAction?.label || card.title || "").trim();
      onOpenChat(card, bootstrap);
    },
    [onOpenChat, persistChatted],
  );

  const dismiss = useCallback(async (card: IntentCard) => {
    setDismissedIds((s) => new Set(s).add(card.id));
    try {
      await proxyPost("/feedback", {
        kind: "dismiss",
        intentCardId: card.id,
        basket: card.goalBasket,
        channel: "web",
      });
    } catch {
      /* swallow */
    }
  }, []);

  const snooze = useCallback(async (card: IntentCard) => {
    setDismissedIds((s) => new Set(s).add(card.id));
    try {
      await proxyPost("/feedback", {
        kind: "snooze",
        intentCardId: card.id,
        basket: card.goalBasket,
        channel: "web",
      });
    } catch {
      /* swallow */
    }
  }, []);

  const modify = useCallback(
    async (card: IntentCard) => {
      setProcessingIds((s) => new Set(s).add(card.id));
      persistChatted(card.id);
      try {
        await proxyPost("/feedback", {
          kind: "card_action",
          action: "modify",
          intentCardId: card.id,
          basket: card.goalBasket,
          channel: "web",
        });
      } catch {
        /* swallow */
      }
      onOpenChat(card, "");
    },
    [onOpenChat, persistChatted],
  );

  const complete = useCallback(async (card: IntentCard) => {
    setDoneIds((s) => new Set(s).add(card.id));
    setProcessingIds((s) => {
      const n = new Set(s);
      n.delete(card.id);
      return n;
    });
    try {
      await proxyPost("/feedback", {
        kind: "card_action",
        action: "complete",
        intentCardId: card.id,
        basket: card.goalBasket,
        channel: "web",
      });
    } catch {
      /* swallow */
    }
  }, []);

  const openChat = useCallback(
    (card: IntentCard) => {
      setProcessingIds((s) => new Set(s).add(card.id));
      persistChatted(card.id);
      onOpenChat(card, "");
    },
    [onOpenChat, persistChatted],
  );

  const textFeedback = useCallback(async (card: IntentCard, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await proxyPost("/feedback", {
        kind: "text_feedback",
        intentCardId: card.id,
        basket: card.goalBasket,
        channel: "web",
        text: trimmed,
      });
    } catch {
      /* swallow */
    }
  }, []);

  return {
    processingIds,
    doneIds,
    confirmedIds,
    dismissedIds,
    chattedIds,
    confirm,
    dismiss,
    snooze,
    modify,
    complete,
    openChat,
    textFeedback,
  };
}
