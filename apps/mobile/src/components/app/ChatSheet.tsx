/**
 * ASK PIN AI 上拉 chat 容器——web 底部 "^ ASK PIN AI" → 全屏 chat 的 RN
 * 对应物。常 mount（translateY 滑出屏外）保住在流 SSE——与 web AppLayout
 * 保 mount 策略同构；顶部收起箭头对齐 web。
 */
import { useEffect } from "react";
import { Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { ChevronDown } from "lucide-react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import ChatScreen from "../../screens/ChatScreen";

export default function ChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { height } = useWindowDimensions();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
    });
  }, [open, progress]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * height }],
  }));

  return (
    <Animated.View
      className="bg-background"
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={open ? "auto" : "none"}
    >
      <Pressable onPress={onClose} hitSlop={10} className="items-start px-5 pt-3 pb-1">
        <ChevronDown size={22} color="#71717a" strokeWidth={1.8} />
      </Pressable>
      <ChatScreen kind="main" />
    </Animated.View>
  );
}
