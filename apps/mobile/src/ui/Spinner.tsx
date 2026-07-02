/**
 * 旋转 Loader2——web `<Loader2 className="animate-spin" />` 的 RN 对应物
 * （reanimated 800ms 线性无限旋转）。connect 系组件共用。
 */
import { useEffect } from "react";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Loader2 } from "lucide-react-native";

export function Spinner({
  size,
  color,
  strokeWidth = 2,
}: {
  size: number;
  color: string;
  strokeWidth?: number;
}) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
  }, [r]);
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={st}>
      <Loader2 size={size} strokeWidth={strokeWidth} color={color} />
    </Animated.View>
  );
}
