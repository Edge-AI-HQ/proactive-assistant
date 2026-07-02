/**
 * onboarding 系共用的 Loader2 旋转（dev lucide `animate-spin` = 1s linear）。
 * 转场态短暂挂载，不接 PageActiveContext（onboarding 完成即整树卸载）。
 */
import { useEffect } from "react";
import { Loader2 } from "lucide-react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

export default function Spin({ size, color }: { size: number; color: string }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Loader2 size={size} color={color} strokeWidth={2} />
    </Animated.View>
  );
}
