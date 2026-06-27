/**
 * ASK PIN AI 上拉 chat 容器——web ChatSheetOverlay 的 RN 对应物。常 mount
 * （translateY 滑出屏外）保住在流 SSE——与 web AppLayout 保 mount 策略同构。
 * 动效照搬 web：入场从屏底 spring(320/32/0.9) 弹上；退出走
 * `useSinkDismissGesture`（任意处右滑 → 跟手把整张 sheet 往下沉、露出底下页面，
 * 过阈值退出 / 不到弹回），和 card chat 同一份手势，体感一致。
 *
 * 满屏出血 + 安全区：与 CardChatScreen 同构——overlay 用负 inset escape 根
 * SafeAreaView 铺满整屏（aurora 顶到刘海后面，对齐 web ConversationView
 * `absolute inset-0` 全铺底）；header 用 `insets.top` 垫下来避刘海、composer
 * 用 `insets.bottom` 垫起避 home-indicator。header = 单个 ChevronDown
 * dismiss-down（对齐 web ConversationView 默认 backIcon="down"：size 20 /
 * strokeWidth 1.5 / foreground-65），main chat 无标题（landing 的问候承载）。
 */
import { useEffect } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown } from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import ChatScreen from "../../screens/ChatScreen";
import AuroraBackground from "../../ui/AuroraBackground";
import { useSinkDismissGesture } from "../chat/useSinkDismiss";

const FG = "29,33,48";

export default function ChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 面板纵向偏移：0 = 全开，height = 收起在屏外。
  const y = useSharedValue(height);

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
      {/* web ChatSheetOverlay 同构：不透明底 + 同款 aurora 层，面板下滑时
          作为整体一起走，不透出下层。 */}
      <AuroraBackground />
      {/* 整张内容包进手势：任意处右滑都能下沉退出。 */}
      <GestureDetector gesture={sink}>
        <View style={styles.content}>
          {/* header：单个 ChevronDown（dismiss-down）；paddingTop 用 insets.top 避刘海。 */}
          <View style={[styles.header, { paddingTop: 12 + insets.top }]}>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Close chat"
            >
              <ChevronDown size={20} strokeWidth={1.5} color={`rgba(${FG},0.65)`} />
            </Pressable>
          </View>
          <ChatScreen kind="main" bottomInset={insets.bottom} open={open} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // --background 220 30% 96% ≈ #f2f4f8（web bg-background 同源）。top/bottom 由
  // inline 负 inset 给（满屏出血，同 CardChatScreen）。
  root: { position: "absolute", left: 0, right: 0, backgroundColor: "#f2f4f8" },
  content: { flex: 1 },
  // web header: px-4 pb-2，按钮 p-2 -ml-1。main chat 无标题、无下边框（无 headerSlot）。
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { marginLeft: -4, padding: 8, borderRadius: 999 },
});
