/**
 * ASK PIN AI 上拉 chat 容器——web ChatSheetOverlay 的 RN 对应物。常 mount
 * （translateY 滑出屏外）保住在流 SSE——与 web AppLayout 保 mount 策略同构。
 * 动效照搬 web：入场从屏底 spring(320/32/0.9) 弹上；退场 0.5s
 * cubic-bezier(.32,.72,0,1) 下沉；左缘(20px) 右拖 → 整面板跟手下沉
 * （SINK_RATIO 1.5），松手超 0.35*屏宽或 vx>400 即 dismiss，否则
 * spring(500/40) 回弹。
 */
import { useEffect } from "react";
import { Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import ChatScreen from "../../screens/ChatScreen";
import AuroraBackground from "../../ui/AuroraBackground";

/** web main-chat-entry-gesture / ChatSheetOverlay 同款常量。 */
const LEFT_EDGE_PX = 20;
const SINK_RATIO = 1.5;
const COMMIT_DISTANCE_FRACTION = 0.35;
const COMMIT_VELOCITY = 400;

export default function ChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { height, width } = useWindowDimensions();
  // 面板纵向偏移：0 = 全开，height = 收起在屏外。
  const y = useSharedValue(height);

  useEffect(() => {
    // overshootClamping：欠阻尼过冲会让 sheet 冲过屏顶再落回（弹跳感）。
    y.value = open
      ? withSpring(0, { stiffness: 320, damping: 32, mass: 0.9, overshootClamping: true })
      : withTiming(height, { duration: 500, easing: Easing.bezier(0.32, 0.72, 0, 1) });
  }, [open, height, y]);

  // 左缘右拖 → 下沉（web：rightward drag offset → downward travel）。
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
        y.value = withTiming(height, {
          duration: 500,
          easing: Easing.bezier(0.32, 0.72, 0, 1),
        });
        runOnJS(onClose)();
      } else {
        y.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
      }
    });

  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  return (
    <Animated.View
      className="bg-background"
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={open ? "auto" : "none"}
    >
      {/* web ChatSheetOverlay 同构：不透明底 + 同款 aurora 层，面板下滑时
          作为整体一起走，不透出下层。 */}
      <AuroraBackground />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close chat"
        onPress={onClose}
        hitSlop={10}
        className="items-start px-5 pt-3 pb-1"
      >
        <ChevronDown size={22} color="#71717a" strokeWidth={1.8} />
      </Pressable>
      <ChatScreen kind="main" />
      {/* 左缘手势热区（最后渲染、最高 z，对齐 web 的 hit-zone 设计）。 */}
      <GestureDetector gesture={edgeSink}>
        <Animated.View style={styles.edgeZone} />
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  edgeZone: { position: "absolute", left: 0, top: 60, bottom: 0, width: LEFT_EDGE_PX },
});
