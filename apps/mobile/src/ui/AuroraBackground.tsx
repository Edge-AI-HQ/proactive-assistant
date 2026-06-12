/**
 * Aurora 流动背景——web `.animate-bg-flow`（135° 八段渐变 60s 漂移）+
 * aurora 色斑层的 RN 对应物。实现：基底 135° 渐变 + 两个大半径径向色斑
 * （粉紫/桃青）用 reanimated 做 60s 相位错开的缓慢平移缩放——视觉等价
 * 于 web 的 background-position 漂移。web 已有 native-power-save 静态
 * 降级先例，色值取自同一组 hsl token。
 */
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

const BASE_COLORS = [
  "hsl(220, 30%, 94%)",
  "hsl(280, 30%, 90%)",
  "hsl(320, 28%, 92%)",
  "hsl(210, 32%, 93%)",
  "hsl(250, 28%, 91%)",
  "hsl(290, 28%, 91%)",
] as const satisfies readonly [string, string, ...string[]];

function Blob({
  colors,
  size,
  initial,
  drift,
  duration,
}: {
  colors: [string, string];
  size: number;
  initial: { top: number; left: number };
  drift: { x: number; y: number };
  duration: number;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t, duration]);
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: t.value * drift.x },
      { translateY: t.value * drift.y },
      { scale: 1.05 + t.value * 0.15 },
    ],
  }));
  return (
    <Animated.View
      style={[
        styles.blob,
        { width: size, height: size, borderRadius: size / 2, ...initial },
        style,
      ]}
    >
      <LinearGradient
        colors={[colors[0], colors[1], "transparent"]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.3, y: 0.3 }}
        end={{ x: 1, y: 1 }}
      />
    </Animated.View>
  );
}

export default function AuroraBackground() {
  return (
    <Animated.View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={BASE_COLORS}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Blob
        colors={["hsla(304, 75%, 78%, 0.35)", "hsla(265, 70%, 80%, 0.22)"]}
        size={520}
        initial={{ top: -120, left: -100 }}
        drift={{ x: 70, y: 50 }}
        duration={30_000}
      />
      <Blob
        colors={["hsla(20, 80%, 82%, 0.30)", "hsla(190, 60%, 82%, 0.20)"]}
        size={560}
        initial={{ top: 380, left: 60 }}
        drift={{ x: -60, y: -40 }}
        duration={42_000}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  blob: { position: "absolute", overflow: "hidden", opacity: 0.9 },
});
