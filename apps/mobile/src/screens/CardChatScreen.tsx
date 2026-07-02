/**
 * Card chat —— production iOS（proactive-ai-frontend 的 CardChatOverlay）的 RN
 * 对应物：和主聊天 ChatSheet **同一范式**（底部上拉 sheet + 右滑 → 整屏跟手下沉、
 * 露出底下页面；不是横向滑出、不是独立 Modal 窗口）。
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
 * 动效：spring(320/32/.9) 上弹；下沉 0.5s cubic(.32,.72,0,1)。退出手势统一走
 * `useSinkDismissGesture`（任意处右滑 → 跟手下沉，过阈值退出 / 不到弹回），和
 * main chat ChatSheet 同一份，体感一致。
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  cardActionFeedbackBody,
  dismissFeedbackBody,
  type IntentCard,
} from "@pin-ai/core";

import ChatScreen from "./ChatScreen";
import AuroraBackground from "../ui/AuroraBackground";
import CardContextHeaderSlot from "../components/chat/CardContextHeaderSlot";
import CardDetailSheet from "../components/now/CardDetailSheet";
import { useSinkDismissGesture } from "../components/chat/useSinkDismiss";
import { postCardFeedback } from "../hooks/useCardActions";

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
  const { t } = useTranslation("chat");
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

  // 退出手势：任意处右滑 → 跟手下沉（main chat / card chat 统一，见 useSinkDismiss）。
  const sink = useSinkDismissGesture(y, height, width, onClose);
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
          {/* 整张内容包进手势：任意处右滑都能下沉退出（CardDetailSheet 是独立浮层，
              不进手势区）。 */}
          <GestureDetector gesture={sink}>
            <View style={styles.content}>
              {/* header：← + 卡片标题（对齐 web ConversationView backIcon="left"，
                  无右侧按钮）；paddingTop 用 insets.top 避刘海。 */}
              <View style={[styles.header, { paddingTop: 12 + insets.top }]}>
                <Pressable
                  onPress={onClose}
                  hitSlop={8}
                  style={styles.backBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t("header.back")}
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
                open={open}
              />
            </View>
          </GestureDetector>

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
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // --background 220 30% 96% ≈ #f2f4f8（web bg-background 同源）。left/right/top/
  // bottom 由 inline 负 inset 给（满屏出血）。
  root: { position: "absolute", left: 0, right: 0, backgroundColor: "#f2f4f8" },
  content: { flex: 1 },
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
  // web h2 text-display text-body(15) text-foreground + pr-12，截断避开右上浮动菜单。
  title: { flex: 1, paddingRight: 48, fontSize: 15, fontWeight: "600", color: "#1a1a1a" },
});
