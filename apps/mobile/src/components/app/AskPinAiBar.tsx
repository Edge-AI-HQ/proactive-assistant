/**
 * 底部 ASK PIN AI 入口——web 底部 "^ ASK PIN AI" 小字的 RN 对应物（上拉
 * 手势 + 点击均可打开 chat；箭头浮动同 web framer `y:[0,-4,0]
 * opacity:[0.45,0.75,0.45]` 2.2s 循环）。
 */
import { useEffect } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronUp } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { usePageActive } from "./KeepAlivePage";
import { useFullCover } from "../../lib/full-cover";

function FloatingChevron() {
  const t = useSharedValue(0);
  // NOW 页不可见（切走 / 被 chat 盖住）时停帧,不空转 UI 线程（WS6）。
  const active = usePageActive();
  const covered = useFullCover();
  const running = active && !covered;
  useEffect(() => {
    if (!running) {
      cancelAnimation(t);
      return;
    }
    t.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(t);
  }, [t, running]);
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
  const { t } = useTranslation("common");
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
        accessibilityLabel={t("appShell.openMainChat")}
        className="items-center pb-2 pt-1"
      >
        <FloatingChevron />
        {/* dev 是 t(appShell.askPinAi) + CSS uppercase；RN 用 textTransform 等价
            （原来烤死大写 "ASK PIN AI"，切语言不会翻，故改回 dev 形态）。 */}
        <Text
          className="text-[11px] tracking-[3px] text-muted-foreground"
          style={{ fontFamily: "Inter_500Medium", textTransform: "uppercase" }}
        >
          {t("appShell.askPinAi")}
        </Text>
      </Pressable>
    </GestureDetector>
  );
}
