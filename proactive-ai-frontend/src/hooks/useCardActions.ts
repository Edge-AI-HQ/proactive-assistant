import { useCallback, useEffect, useState } from "react";

import { proxyFetch, proxyPost, type IntentCard } from "@pin-ai/core";
import { enqueueFeedback } from "@/lib/sync/sync-bootstrap";
import {
  cardActionFeedbackBody,
  confirmBootstrap,
  dismissFeedbackBody,
  snoozeFeedbackBody,
  steerBootstrap,
  textFeedbackBody,
} from "@pin-ai/core";
import {
  canonicalConnectorSlugFromIntentKey,
  openPreparedConnectorOAuth,
  prepareConnectorOAuth,
} from "@/lib/connector-card";
import type { ComposioState } from "@/hooks/useComposio";

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
   *   - confirm：primaryAction.agentPrompt（回退 label / card.title）— 给 agent
   *     的执行任务句，让它直接按原方案推进。
   *   - modify (Steer)：一段"想调整、先问意图"的 instruction — 让 agent 主动
   *     在卡片 chat 里作为普通首条用户消息启动 agent；ChatDetailView
   *     现在复用 MainChatView，所以即使没有 bootstrap 也有底部全局 composer。
   */
  onOpenChat: (card: IntentCard, bootstrapMessage: string) => void;
  /**
   * Caller-owned Composio state. Injected (rather than this hook calling
   * `useComposio()` itself) so the live shell shares ONE useComposio
   * instance — otherwise every consumer of useCardActions would spawn its
   * own /composio/status + /composio/connections poll on mount and hold
   * its own connections[] state. Used by the connect:* short-circuit in
   * `confirm` to skip the chat-open path and trigger OAuth directly.
   */
  composio: ComposioState;
}

/**
 * 把 AppShell 里 confirm / dismiss / snooze / modify / complete / chat /
 * text_feedback 的副作用抽到一处，让 AppLayout 复用。**所有
 * `/feedback` POST 的 payload 形态严格沿用 AppShell 现行实现**（`kind` 维度
 * 分 `card_action` / `dismiss` / `snooze` / `text_feedback`；`intentCardId` +
 * `basket` + `channel: "web"`），不动协议。
 */
export function useCardActions({ onOpenChat, composio }: UseCardActionsOptions) {
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

      // Connector-guidance card (intent_key="connect:<slug>"): show a
      // local pending state while Composio prepares the redirect URL,
      // then mark the card done. Skip chat — the connect flow lives in
      // the popup, not in a conversation.
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
        try {
          await proxyPost("/feedback", cardActionFeedbackBody("complete", card));
        } catch {
          /* UI already optimistic; offline → outbox replays on reconnect */
          void enqueueFeedback(cardActionFeedbackBody("complete", card), `fb:complete:${cardId}`);
        }
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
      persistChatted(cardId);
      try {
        await proxyPost("/feedback", cardActionFeedbackBody("confirm", card));
      } catch {
        void enqueueFeedback(cardActionFeedbackBody("confirm", card), `fb:confirm:${cardId}`);
      }
      onOpenChat(card, confirmBootstrap(card));
    },
    [composio, onOpenChat, persistChatted],
  );

  const dismiss = useCallback(async (card: IntentCard) => {
    setDismissedIds((s) => new Set(s).add(card.id));
    try {
      await proxyPost("/feedback", dismissFeedbackBody(card));
    } catch {
      void enqueueFeedback(dismissFeedbackBody(card), `fb:dismiss:${card.id}`);
    }
  }, []);

  const snooze = useCallback(async (card: IntentCard) => {
    setDismissedIds((s) => new Set(s).add(card.id));
    try {
      await proxyPost("/feedback", snoozeFeedbackBody(card));
    } catch {
      void enqueueFeedback(snoozeFeedbackBody(card), `fb:snooze:${card.id}`);
    }
  }, []);

  const modify = useCallback(
    async (card: IntentCard) => {
      setProcessingIds((s) => new Set(s).add(card.id));
      persistChatted(card.id);
      try {
        await proxyPost("/feedback", cardActionFeedbackBody("modify", card));
      } catch {
        void enqueueFeedback(cardActionFeedbackBody("modify", card), `fb:modify:${card.id}`);
      }
      onOpenChat(card, steerBootstrap(card));
    },
    [onOpenChat, persistChatted],
  );

  const complete = useCallback(async (card: IntentCard) => {
    // `complete` is the terminal Done action — typically fired from
    // ChatDetailView.handleConfirmDone after the user explicitly
    // confirms the card is finished. processingIds was set earlier
    // by openChat / confirm to render the "Processing…" spinner on
    // the sphere; once the user has answered "this is done", that
    // spinner must come off whether or not the POST succeeded.
    // Otherwise a transient blip on /feedback leaves the card spinning
    // forever and the caller's `if (persisted === false) return;`
    // silently no-ops with no visible feedback to the user.
    let persisted = false;
    try {
      const res = await proxyPost("/feedback", cardActionFeedbackBody("complete", card));
      persisted = res.ok;
      if (!res.ok) {
        console.warn(
          `[card] complete POST failed: ${res.status} — clearing spinner so user can retry`,
        );
      }
    } catch (err) {
      console.warn("[card] complete POST threw — clearing spinner so user can retry", err);
      persisted = false;
    }
    setProcessingIds((s) => {
      if (!s.has(card.id)) return s;
      const n = new Set(s);
      n.delete(card.id);
      return n;
    });
    if (persisted) {
      setDoneIds((s) => new Set(s).add(card.id));
    }
    return persisted;
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
      await proxyPost("/feedback", textFeedbackBody(card, trimmed));
    } catch {
      void enqueueFeedback(textFeedbackBody(card, trimmed));
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
  const clearConfirmed = useCallback((id: string) => {
    setConfirmedIds((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
  const markProcessing = useCallback(
    (id: string) => setProcessingIds((s) => new Set(s).add(id)),
    [],
  );
  const clearProcessing = useCallback((id: string) => {
    setProcessingIds((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
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
    clearConfirmed,
    markProcessing,
    clearProcessing,
    markDone,
    markChatted,
  };
}
