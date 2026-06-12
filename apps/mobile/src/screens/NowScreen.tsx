/**
 * NOW 视图（RN 第二刀）——卡片流 + 操作。数据与协议 100% 复用：
 * `useCardsQuery`（@pin-ai/state，TQ 轮询/缓存）+ core 的 feedback body
 * builders + `isHiddenCardOutcome` 可见性语义；离线时 POST 失败走
 * `enqueueFeedback`（同步引擎 outbox，pass/门铃驱动重放）。
 * web 的 3D 球面是视觉打磨刀，本刀先用干净的卡片列表立交互。
 */
import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  cardActionFeedbackBody,
  confirmBootstrap,
  dismissFeedbackBody,
  isHiddenCardOutcome,
  proxyPost,
  snoozeFeedbackBody,
  steerBootstrap,
  type GoalBasket,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardsQuery } from "@pin-ai/state";

import { enqueueFeedback } from "../lib/sync/sync-bootstrap";

const BASKET_COLORS: Record<GoalBasket, string> = {
  work: "#2563eb",
  life: "#16a34a",
  health: "#dc2626",
  wealth: "#ca8a04",
  growth: "#9333ea",
  family: "#ea580c",
};

/** 投递 feedback：到达服务器即算完成；网络失败入 outbox 可靠重放（与
 *  web useCardActions 的语义一致——UI 已乐观，不回滚）。 */
async function postFeedback(body: Record<string, unknown>, dedupeKey?: string): Promise<void> {
  try {
    await proxyPost("/feedback", body);
  } catch {
    await enqueueFeedback(body, dedupeKey);
  }
}

function Card({
  entry,
  onOpenChat,
  onHide,
}: {
  entry: VisibleCardEntry;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  onHide: (cardId: string) => void;
}) {
  const { card } = entry;
  const color = BASKET_COLORS[card.goalBasket] ?? "#71717a";

  const confirm = () => {
    void postFeedback(cardActionFeedbackBody("confirm", card), `fb:confirm:${card.id}`);
    onOpenChat(card, confirmBootstrap(card));
  };
  const steer = () => {
    void postFeedback(cardActionFeedbackBody("modify", card), `fb:modify:${card.id}`);
    onOpenChat(card, steerBootstrap(card));
  };
  const dismiss = () => {
    onHide(card.id);
    void postFeedback(dismissFeedbackBody(card), `fb:dismiss:${card.id}`);
  };
  const snooze = () => {
    onHide(card.id);
    void postFeedback(snoozeFeedbackBody(card), `fb:snooze:${card.id}`);
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.basketDot, { backgroundColor: color }]} />
        <Text style={styles.basketLabel}>{card.goalBasket}</Text>
      </View>
      <Text style={styles.title}>{card.title}</Text>
      {card.whyNow ? <Text style={styles.whyNow}>{card.whyNow}</Text> : null}
      {card.summary ? <Text style={styles.summary}>{card.summary}</Text> : null}
      <View style={styles.actions}>
        <Pressable style={[styles.action, styles.primary]} onPress={confirm}>
          <Text style={styles.primaryText}>{card.primaryAction?.label || "Confirm"}</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={steer}>
          <Text style={styles.actionText}>Steer</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={snooze}>
          <Text style={styles.actionText}>Snooze</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={dismiss}>
          <Text style={styles.actionText}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function NowScreen({
  onOpenChat,
}: {
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
}) {
  const { cards, loading, refresh } = useCardsQuery();
  // 乐观隐藏：dismiss/snooze 即时消失；服务端 outcome（latestOutcome）随
  // 下次 cards 刷新接管真相。
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const onHide = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
  }, []);

  const visible = cards.filter(
    (e) => !isHiddenCardOutcome(e.latestOutcome) && !hidden.has(e.card.id),
  );

  return (
    <FlatList
      style={styles.root}
      contentContainerStyle={styles.content}
      data={visible}
      keyExtractor={(e) => e.card.id}
      renderItem={({ item }) => <Card entry={item} onOpenChat={onOpenChat} onHide={onHide} />}
      refreshControl={
        <RefreshControl refreshing={loading && visible.length > 0} onRefresh={() => void refresh()} />
      }
      ListEmptyComponent={
        <Text style={styles.empty}>
          {loading ? "Loading your cards…" : "All clear — PIN AI is watching for what's next."}
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f4f0" },
  content: { padding: 16, paddingBottom: 24, gap: 12 },
  empty: { textAlign: "center", marginTop: 80, color: "#a1a1aa", fontSize: 15 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  cardHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  basketDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  basketLabel: { fontSize: 12, color: "#71717a", textTransform: "capitalize" },
  title: { fontSize: 17, fontWeight: "600", color: "#1a1a1a", lineHeight: 23 },
  whyNow: { marginTop: 6, fontSize: 13, color: "#a16207", lineHeight: 18 },
  summary: { marginTop: 6, fontSize: 14, color: "#52525b", lineHeight: 20 },
  actions: { flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" },
  action: {
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: "#f4f4f5",
  },
  primary: { backgroundColor: "#1a1a1a" },
  primaryText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  actionText: { color: "#3f3f46", fontSize: 13, fontWeight: "500" },
});
