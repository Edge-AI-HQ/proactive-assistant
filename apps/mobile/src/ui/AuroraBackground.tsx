/**
 * Aurora 静态背景——对齐 dev 的 native-power-save(唯一视觉真源)。
 *
 * dev(proactive-ai-frontend 经 Capacitor 到 iOS)在 native 上永远开
 * `html.native-power-save`(见 packages/ui-web/src/auth/platform.ts),
 * 把 aurora 层的 `animation / filter(模糊) / mix-blend-mode / transform`
 * 全部关掉(index.css `html.native-power-save .aurora-layer`),只留一张
 * 静态柔和色斑。早期 RN 版却用了 Skia Blur(sigma 30)+ 3 层 screen 混合
 * + 3 个 `withRepeat(-1)` 无限动画——每帧重新合成 = 真机发热主因之一,且
 * 与 dev 的省电策略相悖。这里改成「画一次」的静态实现:
 *   底图 @60% + 3 组柔和 RadialGradient 色斑(color 0% → transparent 60%,
 *   自带羽化,无需额外 blur / blend / 动画) + white/35 蒙版。
 * 零逐帧开销;chat / card chat 常驻挂载也几乎不耗电。
 */
import type { ReactNode } from "react";
import { Image, StyleSheet, View, useWindowDimensions } from "react-native";
import { Canvas, Oval, RadialGradient, vec } from "@shopify/react-native-skia";

/** web radial-gradient(ellipse rx% ry% at cx% cy%, color 0%, transparent 60%)。
 *  位置/色值沿用早先动画版的三层色斑(去掉 drift 动画,取静止姿态)。 */
type Spot = { cx: number; cy: number; rx: number; ry: number; color: string };

const SPOTS: Spot[] = [
  { cx: 0.25, cy: 0.3, rx: 0.6, ry: 0.5, color: "hsla(280, 70%, 78%, 0.55)" },
  { cx: 0.75, cy: 0.2, rx: 0.5, ry: 0.45, color: "hsla(320, 65%, 80%, 0.45)" },
  { cx: 0.8, cy: 0.7, rx: 0.55, ry: 0.5, color: "hsla(210, 70%, 82%, 0.5)" },
  { cx: 0.2, cy: 0.8, rx: 0.45, ry: 0.4, color: "hsla(250, 60%, 82%, 0.45)" },
  { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.45, color: "hsla(200, 70%, 85%, 0.4)" },
  { cx: 0.6, cy: 0.9, rx: 0.4, ry: 0.35, color: "hsla(290, 60%, 82%, 0.4)" },
];

/** 单斑:Oval + 同形 RadialGradient,0% 色 → 60% 处透明(同色 alpha 0,防灰边)。 */
function SkiaSpot({ spot, w, h }: { spot: Spot; w: number; h: number }) {
  const cx = spot.cx * w;
  const cy = spot.cy * h;
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

export default function AuroraBackground({
  veilOpacity = 0.35,
  children,
}: {
  /** 顶层白罩透明度。chat 两屏默认 0.35；登录页 dev 是 bg-white/30 → 0.3。 */
  veilOpacity?: number;
  /** 插在色斑与白罩之间的层（登录页的 nebula 视频用，dev LoginBackdrop 同序）。 */
  children?: ReactNode;
}) {
  const { width: w, height: h } = useWindowDimensions();
  return (
    <View style={[StyleSheet.absoluteFill, styles.isolate]} pointerEvents="none">
      <Image
        source={require("../assets/bg-gradient.jpg")}
        style={[StyleSheet.absoluteFill, styles.baseImage]}
        resizeMode="cover"
      />
      {/* 静态 Skia 画布:所有色斑画一次,无 Blur / 无 mixBlend / 无动画。 */}
      <Canvas style={StyleSheet.absoluteFill}>
        {SPOTS.map((spot, i) => (
          <SkiaSpot key={i} spot={spot} w={w} h={h} />
        ))}
      </Canvas>
      {children}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255,255,255,${veilOpacity})` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  isolate: { isolation: "isolate" },
  baseImage: { width: "100%", height: "100%", opacity: 0.6 },
});
