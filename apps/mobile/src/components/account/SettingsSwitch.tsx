/**
 * 设置面开关 —— web account 系组件里两种内联 switch 的 RN 对应物：
 * - md（AutoEvolutionSettings / ScheduledTasksSettings）：h-7 w-12(28×48) + 20 拇指，
 *   on bg-primary / off bg-foreground/10，border-foreground/10，拇指 shadow-md。
 * - sm（AutoGenerateSettings）：h-6 w-11(24×44) + 16 拇指，
 *   on bg-primary border-primary / off bg-foreground/15 border-foreground/15，shadow-sm。
 * 两者拇指位移都是 translate-x 3→22，transition 200ms。disabled opacity-40。
 * Pressable 只管 onPress（本项目 Pressable 的 style 不渲染 → 视觉全在内层 View）。
 */
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

const PRIMARY = "hsl(292, 78%, 63%)";
const FG = "230, 25%, 15%";
const fg = (a: number) => `hsla(${FG}, ${a})`;

const SIZES = {
  sm: {
    width: 44,
    height: 24,
    thumb: 16,
    onBg: PRIMARY,
    onBorder: PRIMARY,
    offBg: fg(0.15),
    offBorder: fg(0.15),
    shadow: { shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  },
  md: {
    width: 48,
    height: 28,
    thumb: 20,
    onBg: PRIMARY,
    onBorder: fg(0.1),
    offBg: fg(0.1),
    offBorder: fg(0.1),
    shadow: { shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: 4 } },
  },
} as const;

export function SettingsSwitch({
  on,
  disabled = false,
  onPress,
  size = "md",
  accessibilityLabel,
}: {
  on: boolean;
  disabled?: boolean;
  onPress: () => void;
  size?: "sm" | "md";
  accessibilityLabel?: string;
}) {
  const s = SIZES[size];
  const x = useSharedValue(on ? 22 : 3);
  useEffect(() => {
    x.value = withTiming(on ? 22 : 3, { duration: 200 });
  }, [on, x]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={accessibilityLabel}
    >
      <View
        style={{
          width: s.width,
          height: s.height,
          borderRadius: s.height / 2,
          borderWidth: 1,
          borderColor: on ? s.onBorder : s.offBorder,
          backgroundColor: on ? s.onBg : s.offBg,
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 0,
              width: s.thumb,
              height: s.thumb,
              borderRadius: s.thumb / 2,
              backgroundColor: "#fff",
            },
            s.shadow,
            thumbStyle,
          ]}
        />
      </View>
    </Pressable>
  );
}
