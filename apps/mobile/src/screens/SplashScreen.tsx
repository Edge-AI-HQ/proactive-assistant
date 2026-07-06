/**
 * SplashScreen —— App 冷启动的开屏画面（in-app boot splash）：粉色 aurora 背景 +
 * 居中波动球（AiSphere），只有球和背景、无其它元素。作为 App 刚打开时的品牌开屏。
 *
 * 丝滑切换（对齐抖音 / Instagram / 微信）：这一层是**绝对定位盖层**，不透明底盖住
 * 底下的主壳；主壳在 splash 还盖着时就先挂好（App.tsx 提前渲染 content），boot
 * 完成后本层 opacity 1→0 淡出、露出已就绪的主壳，再 onHidden 卸载。淡出跑在
 * reanimated UI 线程 → 即使此刻主壳在 JS 线程挂载也不卡。这就是「两屏同时在场 +
 * 目标屏提前就绪」的 cross-fade，取代原先的硬切。
 *
 * 视觉源 = 设计仓 big-ball-design（`components/BigBallLayout.tsx`）：球 = AiSphere、
 * 背景 = bg-gradient.jpg 粉色。粉背景复用 RN 现役 `AuroraBackground`（同一张
 * bg-gradient.jpg），veil 0.5 对齐设计 bg-white/50；球复用 `AiSphere`（sphere.mp4）。
 * 停留时长 = App.tsx「最短 1.8s + 加载完为止，取长的」gate 控制。
 */
import { useEffect } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import AiSphere from "../ui/AiSphere";
import AuroraBackground from "../ui/AuroraBackground";

/** 球宽 / 屏宽。调这个数：大一点=球更大、背景更少；小一点=球更小、背景更多。 */
const BALL_WIDTH_RATIO = 0.78;

export default function SplashScreen({
  visible,
  onHidden,
}: {
  /** true = 盖着（boot 未完成）；false = 开始淡出。 */
  visible: boolean;
  /** 淡出结束回调（App.tsx 借此卸载本层）。 */
  onHidden: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const size = Math.min(330, width * BALL_WIDTH_RATIO);

  const opacity = useSharedValue(1);
  useEffect(() => {
    if (visible) return;
    opacity.value = withTiming(0, { duration: 420, easing: Easing.out(Easing.quad) }, (done) => {
      if (done) runOnJS(onHidden)();
    });
  }, [visible, opacity, onHidden]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, fadeStyle]}
      // 盖着时吞触摸；淡出时放行 → 用户可提前操作底下已就绪的主壳。
      pointerEvents={visible ? "auto" : "none"}
    >
      {/* 粉色 aurora（bg-gradient.jpg 同源；veil 0.5 = 设计 bg-white/50）。 */}
      <AuroraBackground veilOpacity={0.5} />
      {/* 居中的球，略上移（设计 -mt-[10%]，此处按屏高微调）。active 恒真 → 开屏即播。 */}
      <View style={[styles.center, { transform: [{ translateY: -height * 0.06 }] }]}>
        <AiSphere size={size} mode="idle" active probeKey="splash" />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 不透明粉底（= 原生启动屏同色 #F0E9F6）→ 盖住主壳；淡出时才露出。zIndex 盖顶。
  root: { backgroundColor: "#F0E9F6", zIndex: 100 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
