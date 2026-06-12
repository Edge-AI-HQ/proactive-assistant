/**
 * 底部 ASK PIN AI 入口——web 底部 "^ ASK PIN AI" 小字的 RN 对应物（上拉
 * 手势 + 点击均可打开 chat；箭头浮动同 web framer `y:[0,-4,0]
 * opacity:[0.45,0.75,0.45]` 2.2s 循环）。
 */
import { useEffect } from "react";
import { Pressable, Text } from "react-native";
import { ChevronUp } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

function FloatingChevron() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [t]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(t.value, [0, 1], [0, -4]) }],
    opacity: interpolate(t.value, [0, 1], [0.45, 0.75]),
  }));
  return (
    <Animated.View style={style}>
      <ChevronUp size={16} color="#a1a1aa" strokeWidth={1.8} />
    </Animated.View>
  );
}

export default function AskPinAiBar({ onOpen }: { onOpen: () => void }) {
  const swipeUp = Gesture.Pan()
    .activeOffsetY(-12)
    .onEnd((e) => {
      if (e.translationY < -32) runOnJS(onOpen)();
    });
  return (
    <GestureDetector gesture={swipeUp}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="Ask PIN AI"
        className="items-center pb-2 pt-1"
      >
        <FloatingChevron />
        <Text
          className="text-[11px] tracking-[3px] text-muted-foreground"
          style={{ fontFamily: "Inter_500Medium" }}
        >
          ASK PIN AI
        </Text>
      </Pressable>
    </GestureDetector>
  );
}
