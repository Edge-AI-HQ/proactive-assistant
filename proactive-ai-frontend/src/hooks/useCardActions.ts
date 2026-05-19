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
   * confirm / modify 后回调：调用方负责切到 chat 视图并把 bootstrapMessage 当
   * 首条 user turn 喂给 chat runtime。两条路径都传非空 bootstrap：
   *   - confirm：primaryAction.label / card.title — 让 agent 直接按原方案推进。
   *   - modify (Steer)：一段"想调整、先问意图"的 instruction — 让 agent 主动
   *     `propose_action` 弹一组 chip + 输入框，避免出现"agent 不开口 + ChatDetailView
   *     默认不挂全局 composer"的死局空白页。
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
      // Parallel fetch — dismissed + completed share semantics (both
      // mark a card as "no longer on the sphere") and both must be
      // restored on mount, otherwise the doneIds / dismissedIds Sets
      // start empty after refresh and resolved cards reappear on the
      // sphere until the user re-clicks Dismiss/Done.
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
            // Merge — 用户可能在 init 返回前已经 dismiss 过几张卡，整体
            // 替换会丢掉乐观更新（AppShell 历史上做的是 replace，这里
            // 改 merge 是顺手修正而不是行为变化，因为 init 总在 mount
            // 后立刻发，用户极少有时间在它返回前先动手）。
            setDismissedIds((prev) => {
              const next = new Set(prev);
              for (const id of data.dismissedCardIds!) next.add(id);
              return next;
            });
          }
        } catch {
          /* swallow: dismissed init failure 只影响一次启动 */
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
          /* swallow: completed init failure 只影响一次启动 */
        }
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
      // Steer bootstrap: tell card_execution agent the user wants to
      // adjust direction BEFORE acting. The agent's prompt
      // (<user_reply_contract>) treats non-yes/no text as an
      // instruction and is required to respond via `propose_action`,
      // which surfaces the chip + free-text panel in ChatDetailView's
      // needs-input slot — so the user has somewhere to talk. Without
      // this bootstrap the thread stays empty + the page has no global
      // composer, producing the "only CONTEXT renders" dead state.
      const originalPlan =
        card.primaryAction?.label?.trim() || card.title.trim();
      const steerBootstrap = originalPlan
        ? `I want to steer this before you act. Original plan: ${originalPlan}. Ask me how I'd like to adjust it (recipient, tone, scope, timing, anything else) and wait for my reply before executing.`
        : "I want to steer this card before you act. Ask me how I'd like to adjust it and wait for my reply before executing.";
      onOpenChat(card, steerBootstrap);
    },
    [onOpenChat, persistChatted],
  );

  const complete = useCallback(async (card: IntentCard) => {
    try {
      const res = await proxyPost("/feedback", {
        kind: "card_action",
        action: "complete",
        intentCardId: card.id,
        basket: card.goalBasket,
        channel: "web",
      });
      if (!res.ok) return false;
    } catch {
      return false;
    }
    setDoneIds((s) => new Set(s).add(card.id));
    setProcessingIds((s) => {
      const n = new Set(s);
      n.delete(card.id);
      return n;
    });
    return true;
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

  // ── Pure local-state mutators ── 给 ChatTimeline 这类自己 POST /feedback
  // 的组件用，只用来保持 NOW 视图卡片状态环显示与 timeline 一致。
  const markDismissed = useCallback(
    (id: string) => setDismissedIds((s) => new Set(s).add(id)),
    [],
  );
  const markConfirmed = useCallback(
    (id: string) => setConfirmedIds((s) => new Set(s).add(id)),
    [],
  );
  const markProcessing = useCallback(
    (id: string) => setProcessingIds((s) => new Set(s).add(id)),
    [],
  );
  const markDone = useCallback((id: string) => {
    setDoneIds((s) => new Set(s).add(id));
    setProcessingIds((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
  const markChatted = useCallback(
    (id: string) => persistChatted(id),
    [persistChatted],
  );

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
    markDismissed,
    markConfirmed,
    markProcessing,
    markDone,
    markChatted,
  };
}
