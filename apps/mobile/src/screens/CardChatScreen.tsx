/**
 * Card chat —— production iOS（proactive-ai-frontend 的 CardChatOverlay）的 RN
 * 对应物：和主聊天 ChatSheet **同一范式**（底部上拉 sheet + 左缘右滑 → 整屏跟手
 * 下沉、露出底下页面；不是横向滑出、不是独立 Modal 窗口）。
 *
 * 满屏出血：overlay 在根 SafeAreaView 内，用负 inset 偏移 escape 到整屏（aurora
 * 顶到刘海后面，对齐 web ConversationView `absolute inset-0` 全铺底）；header 再
 * 用 `insets.top` 垫下来避刘海、composer 用 `insets.bottom` 垫起避 home-indicator
 * （对齐 web header `pt-[safe+12]`）。
 *
 * header 对齐 web ConversationView（card chat backIcon="left"）：← ArrowLeft +
 * 卡片标题（text-body 15，截断）。**无右侧按钮**——ChatDetailView 不给
 * ConversationView 传 onDismiss/onDone，Dismiss/Done 在底部结果条 + 详情抽屉。
 *
 * 动效照搬 ChatSheet（= web ChatSheetOverlay）：spring(320/32/.9) 上弹；下沉
 * 0.5s cubic(.32,.72,0,1)；左缘 20px 右拖跟手下沉（SINK_RATIO 1.5），松手**超
 * 阈值**（>0.35 屏宽 或 vx>400）才提交 dismiss，否则 spring(500/40) 回弹（退不出）。
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  cardActionFeedbackBody,
  dismissFeedbackBody,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";

import ChatScreen from "./ChatScreen";
import AuroraBackground from "../ui/AuroraBackground";
import CardContextHeaderSlot from "../components/chat/CardContextHeaderSlot";
import CardDetailSheet from "../components/now/CardDetailSheet";
import { postCardFeedback } from "../hooks/useCardActions";

/** web main-chat-entry-gesture / ChatSheetOverlay 同款常量（与 ChatSheet 一致）。 */
const LEFT_EDGE_PX = 20;
const SINK_RATIO = 1.5;
const COMMIT_DISTANCE_FRACTION = 0.35;
const COMMIT_VELOCITY = 400;
const FG = "29,33,48";

export interface CardChatTarget {
  card: IntentCard;
  bootstrap?: string;
}

export default function CardChatScreen({
  target,
  onClose,
}: {
  /** 非空 = 为该卡挂起 sheet；置空触发下沉退场。 */
  target: CardChatTarget | null;
  onClose: () => void;
}) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const y = useSharedValue(height); // 0 = 全开，height = 收起在屏外。
  const open = target !== null;
  const [detailOpen, setDetailOpen] = useState(false);

  // 锁存最后一次 target：target 清空后退场动画还要再渲染一帧，否则卡片内容会闪空
  // （与 web CardChatOverlay 的 lastTarget 同构）。
  const lastTarget = useRef<CardChatTarget | null>(null);
  if (target) lastTarget.current = target;
  const shown = target ?? lastTarget.current;
  const card = shown?.card ?? null;

  useEffect(() => {
    // overshootClamping：欠阻尼过冲会让 sheet 冲过屏顶再落回（弹跳感）。
    y.value = open
      ? withSpring(0, { stiffness: 320, damping: 32, mass: 0.9, overshootClamping: true })
      : withTiming(height, { duration: 500, easing: Easing.bezier(0.32, 0.72, 0, 1) });
  }, [open, height, y]);

  // 左缘右拖 → 下沉（web：rightward drag offset → downward travel）。**阈值门控**：
  // 松手时只有 translationX 超 0.35 屏宽 或 vx>400 才提交退出，否则回弹（退不出）。
  const edgeSink = Gesture.Pan()
    .hitSlop({ left: 0, width: LEFT_EDGE_PX })
    .activeOffsetX(10)
    .onUpdate((e) => {
      y.value = Math.max(0, e.translationX * SINK_RATIO);
    })
    .onEnd((e) => {
      const commit =
        e.translationX > width * COMMIT_DISTANCE_FRACTION || e.velocityX > COMMIT_VELOCITY;
      if (commit) {
        y.value = withTiming(height, { duration: 500, easing: Easing.bezier(0.32, 0.72, 0, 1) });
        runOnJS(onClose)();
      } else {
        y.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
      }
    });

  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  return (
    <Animated.View
      // 负 inset → escape 根 SafeAreaView，铺满整屏（含刘海后面）。
      style={[styles.root, { top: -insets.top, bottom: -insets.bottom }, style]}
      pointerEvents={open ? "auto" : "none"}
    >
      {/* 不透明底 + aurora：sheet 下沉时整体一起走、不透出下层（web 同构）。 */}
      <AuroraBackground />
      {card ? (
        <>
          {/* header：← + 卡片标题（对齐 web ConversationView backIcon="left"，
              无右侧按钮）；paddingTop 用 insets.top 避刘海。 */}
          <View style={[styles.header, { paddingTop: 12 + insets.top }]}>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <ArrowLeft size={20} strokeWidth={1.5} color={`rgba(${FG},0.65)`} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>
              {card.title}
            </Text>
          </View>

          <CardContextHeaderSlot card={card} onOpen={() => setDetailOpen(true)} />

          <ChatScreen
            kind="card"
            cardId={card.id}
            bootstrap={shown?.bootstrap}
            card={card}
            onCardClose={onClose}
            bottomInset={insets.bottom}
          />

          <CardDetailSheet
            entry={
              detailOpen
                ? {
                    card,
                    runId: "",
                    runCompletedAt: "",
                    score: null,
                    latestOutcome: null,
                    outcomeAt: null,
                    runStatus: null,
                  }
                : null
            }
            onClose={() => setDetailOpen(false)}
            onDismiss={() => {
              void postCardFeedback(dismissFeedbackBody(card), `fb:dismiss:${card.id}`);
              onClose();
            }}
            onComplete={() => {
              void postCardFeedback(cardActionFeedbackBody("complete", card), `fb:complete:${card.id}`);
              onClose();
            }}
            // 已在会话中：Approve / Chat 仅收起详情（不重复开 chat）。
            onApprove={() => setDetailOpen(false)}
            onChat={() => setDetailOpen(false)}
          />
        </>
      ) : null}

      {/* 左缘手势热区（最后渲染、最高 z；top 让开 header，否则抢 ← 的点击）。 */}
      <GestureDetector gesture={edgeSink}>
        <Animated.View style={[styles.edgeZone, { top: insets.top + 60 }]} />
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // --background 220 30% 96% ≈ #f2f4f8（web bg-background 同源）。left/right/top/
  // bottom 由 inline 负 inset 给（满屏出血）。
  root: { position: "absolute", left: 0, right: 0, backgroundColor: "#f2f4f8" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    // web header divider = `border-b border-foreground/8` = 1px（非 hairline）。
    borderBottomWidth: 1,
    borderBottomColor: `rgba(${FG},0.08)`,
  },
  backBtn: { marginLeft: -4, padding: 8, borderRadius: 999 },
  // web h2 text-display text-body(15) text-foreground，截断。
  title: { flex: 1, fontSize: 15, fontWeight: "600", color: "#1a1a1a" },
  edgeZone: { position: "absolute", left: 0, bottom: 0, width: LEFT_EDGE_PX },
});
