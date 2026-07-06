/**
 * Claude 式 shimmer 标签——web ShimmerText（bg-clip-text + backgroundPosition
 * 100%→-100% 2.4s linear 循环）的 RN 介质版：MaskedView 抠字形，底为
 * 32% 灰，一条 95% 亮带从右向左扫过（web 渐变 35/50/65% 同构）。
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { usePageActive } from "../components/app/KeepAlivePage";

/** foreground token（230 25% 15%）。 */
const INK = (a: number) => `rgba(29, 33, 48, ${a})`;

export function ShimmerText({
  text,
  style,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
}) {
  const [width, setWidth] = useState(0);
  const t = useSharedValue(0);
  const active = usePageActive();

  useEffect(() => {
    // 页面不可见（如 chat 收起）时停帧,不再空转 UI 线程（WS6）。
    if (!active) {
      cancelAnimation(t);
      return;
    }
    t.value = withRepeat(withTiming(1, { duration: 2400 }), -1, false);
    return () => cancelAnimation(t);
  }, [t, active]);

  const sweep = useAnimatedStyle(() => ({
    // web backgroundPosition 100%→-100%：亮带从右端扫到左端。
    transform: [{ translateX: interpolate(t.value, [0, 1], [width, -width]) }],
  }));

  return (
    <MaskedView
      maskElement={<Text style={style}>{text}</Text>}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <View style={{ backgroundColor: INK(0.32) }}>
        {/* 透明同款文字撑尺寸。 */}
        <Text style={[style, styles.ghost]}>{text}</Text>
        {width > 0 ? (
          <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
            <LinearGradient
              colors={[INK(0), INK(0.95), INK(0)]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ width: width * 0.6, flex: 1 }}
            />
          </Animated.View>
        ) : null}
      </View>
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  ghost: { opacity: 0 },
});
