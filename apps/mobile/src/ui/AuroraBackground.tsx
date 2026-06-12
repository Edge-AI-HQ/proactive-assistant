/**
 * Aurora 流动背景——web AppLayout 5 层结构的 RN 对应物（介质映射，非类名直译）：
 *   1. bg-gradient.jpg 底图 @60%（web 同款资产）
 *   2-4. `.aurora-layer-{1,2,3}`：每层 2 个 radial 椭圆色斑 + blur(60px)
 *        + mix-blend-mode:screen + 38/52/64s 三相位 translate/scale/rotate 漂移
 *   5. white/35 统一蒙版
 * RN 介质：斑用 Skia 静态绘制（RadialGradient + 整层 Blur sigma=30，即 CSS
 * blur(60px)≈2σ），只画一次零重绘；漂移在外层 Reanimated transform（GPU 合成）；
 * screen 混合走 RN 0.77+ mixBlendMode。Canvas 四周留 bleed 防 blur 光晕被裁出硬边。
 * web 还有 saturate(1.1)，视觉差异极小，未模拟。
 */
import { useEffect } from "react";
import { Image, StyleSheet, View, useWindowDimensions } from "react-native";
import { Blur, Canvas, Group, Oval, Paint, RadialGradient, vec } from "@shopify/react-native-skia";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/** web radial-gradient(ellipse rx% ry% at cx% cy%, color 0%, transparent 60%) */
type Spot = {
  cx: number; // 圆心，相对屏宽/屏高
  cy: number;
  rx: number; // 椭圆半径，相对屏宽/屏高
  ry: number;
  color: string;
};

/** web @keyframes aurora-drift-N：0%/100% = from，50% = to（alternate 同构）。 */
type Drift = {
  from: { x: number; y: number; scale: number; rotate: number };
  to: { x: number; y: number; scale: number; rotate: number };
  duration: number;
};

const LAYERS: { spots: [Spot, Spot]; drift: Drift }[] = [
  {
    spots: [
      { cx: 0.25, cy: 0.3, rx: 0.6, ry: 0.5, color: "hsla(280, 70%, 78%, 0.55)" },
      { cx: 0.75, cy: 0.2, rx: 0.5, ry: 0.45, color: "hsla(320, 65%, 80%, 0.45)" },
    ],
    drift: {
      from: { x: -0.08, y: -0.06, scale: 1.1, rotate: 0 },
      to: { x: 0.1, y: 0.08, scale: 1.25, rotate: 8 },
      duration: 38_000,
    },
  },
  {
    spots: [
      { cx: 0.8, cy: 0.7, rx: 0.55, ry: 0.5, color: "hsla(210, 70%, 82%, 0.5)" },
      { cx: 0.2, cy: 0.8, rx: 0.45, ry: 0.4, color: "hsla(250, 60%, 82%, 0.45)" },
    ],
    drift: {
      from: { x: 0.12, y: 0.1, scale: 1.2, rotate: 0 },
      to: { x: -0.1, y: -0.08, scale: 1.05, rotate: -10 },
      duration: 52_000,
    },
  },
  {
    spots: [
      { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.45, color: "hsla(200, 70%, 85%, 0.4)" },
      { cx: 0.6, cy: 0.9, rx: 0.4, ry: 0.35, color: "hsla(290, 60%, 82%, 0.4)" },
    ],
    drift: {
      from: { x: -0.06, y: 0.12, scale: 1.15, rotate: 0 },
      to: { x: 0.08, y: -0.1, scale: 1.3, rotate: 6 },
      duration: 64_000,
    },
  },
];

/** CSS blur(60px) → Skia sigma（≈ radius/2）。 */
const BLUR_SIGMA = 30;
/** Canvas 出血边，容纳 blur 扩散（~3σ）。 */
const BLEED = 100;

/** 单斑：Oval + 同形 RadialGradient，0% 色 → 60% 处透明（同色 alpha 0，防灰边）。 */
function SkiaSpot({ spot, w, h }: { spot: Spot; w: number; h: number }) {
  const cx = spot.cx * w + BLEED;
  const cy = spot.cy * h + BLEED;
  const rx = spot.rx * w;
  const ry = spot.ry * h;
  const transparent = spot.color.replace(/[\d.]+\)$/, "0)");
  return (
    <Oval x={cx - rx} y={cy - ry} width={rx * 2} height={ry * 2}>
      <RadialGradient
        c={vec(cx, cy)}
        r={Math.max(rx, ry)}
        colors={[spot.color, transparent]}
        positions={[0, 0.6]}
      />
    </Oval>
  );
}

function AuroraLayer({ spots, drift }: { spots: [Spot, Spot]; drift: Drift }) {
  const { width: w, height: h } = useWindowDimensions();
  const t = useSharedValue(0);
  useEffect(() => {
    // CSS ease-in-out = cubic-bezier(0.42, 0, 0.58, 1)，alternate ≡ reverse。
    t.value = withRepeat(
      withTiming(1, { duration: drift.duration, easing: Easing.bezier(0.42, 0, 0.58, 1) }),
      -1,
      true,
    );
  }, [t, drift.duration]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(t.value, [0, 1], [drift.from.x * w, drift.to.x * w]) },
      { translateY: interpolate(t.value, [0, 1], [drift.from.y * h, drift.to.y * h]) },
      { scale: interpolate(t.value, [0, 1], [drift.from.scale, drift.to.scale]) },
      { rotate: `${interpolate(t.value, [0, 1], [drift.from.rotate, drift.to.rotate])}deg` },
    ],
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.screenBlend, style]}>
      <Canvas
        style={{
          position: "absolute",
          left: -BLEED,
          top: -BLEED,
          width: w + BLEED * 2,
          height: h + BLEED * 2,
        }}
      >
        {/* layer = 整层光栅化后再 blur——CSS `filter: blur()` 的正确语义。 */}
        <Group
          layer={
            <Paint>
              <Blur blur={BLUR_SIGMA} />
            </Paint>
          }
        >
          <SkiaSpot spot={spots[0]} w={w} h={h} />
          <SkiaSpot spot={spots[1]} w={w} h={h} />
        </Group>
      </Canvas>
    </Animated.View>
  );
}

export default function AuroraBackground() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.isolate]} pointerEvents="none">
      <Image
        source={require("../assets/bg-gradient.jpg")}
        style={[StyleSheet.absoluteFill, styles.baseImage]}
        resizeMode="cover"
      />
      {LAYERS.map((layer, i) => (
        <AuroraLayer key={i} spots={layer.spots} drift={layer.drift} />
      ))}
      <View style={[StyleSheet.absoluteFill, styles.veil]} />
    </View>
  );
}

const styles = StyleSheet.create({
  isolate: { isolation: "isolate" },
  baseImage: { width: "100%", height: "100%", opacity: 0.6 },
  screenBlend: { mixBlendMode: "screen" },
  veil: { backgroundColor: "rgba(255,255,255,0.35)" },
});
