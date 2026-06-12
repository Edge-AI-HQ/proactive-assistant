/**
 * NOW 视图（UI 刀②：视觉+手势升级）——数据与协议 100% 复用（与第一版
 * 相同：useCardsQuery + core feedback builders + outbox 兜底）；本刀加：
 * - 滑动手势：右滑 Confirm（绿）/ 左滑 Dismiss（灰），阈值触发 +
 *   haptics（与 web 的卡片手势语义对齐）
 * - 进入动画（FadeInDown 错落）与品牌渐变背景
 * - 卡片视觉对齐 web（玻璃质感/whyNow 琥珀/basket 色点）
 * web 的 3D Constellation 球面是需要设计反馈循环的视觉迭代，单列卡片流
 * 为当前形态（README 视觉对齐清单跟踪）。
 */
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeInDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
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

const SWIPE_THRESHOLD = 96;

async function postFeedback(body: Record<string, unknown>, dedupeKey?: string): Promise<void> {
  try {
    await proxyPost("/feedback", body);
  } catch {
    await enqueueFeedback(body, dedupeKey);
  }
}

function Card({
  entry,
  index,
  onOpenChat,
  onHide,
}: {
  entry: VisibleCardEntry;
  index: number;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  onHide: (cardId: string) => void;
}) {
  const { card } = entry;
  const color = BASKET_COLORS[card.goalBasket] ?? "#71717a";
  const translateX = useSharedValue(0);

  const confirm = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void postFeedback(cardActionFeedbackBody("confirm", card), `fb:confirm:${card.id}`);
    onOpenChat(card, confirmBootstrap(card));
  };
  const steer = () => {
    void postFeedback(cardActionFeedbackBody("modify", card), `fb:modify:${card.id}`);
    onOpenChat(card, steerBootstrap(card));
  };
  const dismiss = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onHide(card.id);
    void postFeedback(dismissFeedbackBody(card), `fb:dismiss:${card.id}`);
  };
  const snooze = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onHide(card.id);
    void postFeedback(snoozeFeedbackBody(card), `fb:snooze:${card.id}`);
  };

  // 右滑 confirm / 左滑 dismiss——阈值外松手触发，否则弹回。
  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onUpdate((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      if (e.translationX > SWIPE_THRESHOLD) {
        translateX.value = withTiming(480, { duration: 180 });
        runOnJS(confirm)();
      } else if (e.translationX < -SWIPE_THRESHOLD) {
        translateX.value = withTiming(-480, { duration: 180 });
        runOnJS(dismiss)();
      } else {
        translateX.value = withSpring(0);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const hintStyle = useAnimatedStyle(() => ({
    opacity: Math.min(Math.abs(translateX.value) / SWIPE_THRESHOLD, 1) * 0.9,
  }));

  return (
    <Animated.View entering={FadeInDown.delay(index * 60).springify()}>
      <View style={styles.swipeBed}>
        <Animated.View style={[styles.swipeHints, hintStyle]}>
          <Text style={styles.confirmHint}>✓ Confirm</Text>
          <Text style={styles.dismissHint}>Dismiss ✕</Text>
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.card, animatedStyle]}>
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
          </Animated.View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
}

export default function NowScreen({
  onOpenChat,
}: {
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
}) {
  const { cards, loading, refresh } = useCardsQuery();
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
      renderItem={({ item, index }) => (
        <Card entry={item} index={Math.min(index, 6)} onOpenChat={onOpenChat} onHide={onHide} />
      )}
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
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 24, gap: 12 },
  empty: { textAlign: "center", marginTop: 80, color: "#a1a1aa", fontSize: 15 },
  swipeBed: { position: "relative" },
  swipeHints: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    borderRadius: 18,
  },
  confirmHint: { color: "#16a34a", fontWeight: "700", fontSize: 15 },
  dismissHint: { color: "#71717a", fontWeight: "700", fontSize: 15 },
  card: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 18,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.06)",
    shadowColor: "#000",
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
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
