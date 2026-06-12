/**
 * 底部 ASK PIN AI 入口——web 底部 "^ ASK PIN AI" 小字的 RN 对应物（上拉
 * 手势 + 点击均可打开 chat）。
 */
import { Pressable, Text } from "react-native";
import { ChevronUp } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

export default function AskPinAiBar({ onOpen }: { onOpen: () => void }) {
  const swipeUp = Gesture.Pan()
    .activeOffsetY(-12)
    .onEnd((e) => {
      if (e.translationY < -32) runOnJS(onOpen)();
    });
  return (
    <GestureDetector gesture={swipeUp}>
      <Pressable onPress={onOpen} className="items-center pb-2 pt-1">
        <ChevronUp size={16} color="#a1a1aa" strokeWidth={1.8} />
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
