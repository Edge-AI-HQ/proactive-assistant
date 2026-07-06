/**
 * Aurora 静态背景——对齐 dev 的 native-power-save(唯一视觉真源)。
 *
 * dev(proactive-ai-frontend 经 Capacitor 到 iOS)在 native 上永远开
 * `html.native-power-save`(见 packages/ui-web/src/auth/platform.ts),把 aurora
 * 层的 `animation / filter(模糊) / mix-blend-mode / transform` 全关，只留一张
 * 静态柔和色斑。此前 RN 版用 Skia Canvas 画这张静止图，代价是引入
 * `@shopify/react-native-skia`(~85MB 原生库)+ 常驻 GPU surface——为一张不动的
 * 图养一个重型绘图引擎，纯浪费。改用已在依赖里、已原生链接的 react-native-svg
 * (RadialGradient) 1:1 复刻同样的静态色斑，删掉 Skia：
 *   底图 @60% + 6 组柔和 RadialGradient 色斑(color 0% → transparent 60%，自带
 *   羽化，无需 blur / blend / 动画) + white 蒙版。零逐帧开销；chat / card chat
 *   常驻挂载也几乎不耗电。
 */
import { useId, type ReactNode } from "react";
import { Image, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";

/** web radial-gradient(ellipse rx% ry% at cx% cy%, color 0%, transparent 60%)。
 *  位置/色值沿用早先动画版的三层色斑(去掉 drift 动画，取静止姿态)。 */
type Spot = { cx: number; cy: number; rx: number; ry: number; color: string };

const SPOTS: Spot[] = [
  { cx: 0.25, cy: 0.3, rx: 0.6, ry: 0.5, color: "hsla(280, 70%, 78%, 0.55)" },
  { cx: 0.75, cy: 0.2, rx: 0.5, ry: 0.45, color: "hsla(320, 65%, 80%, 0.45)" },
  { cx: 0.8, cy: 0.7, rx: 0.55, ry: 0.5, color: "hsla(210, 70%, 82%, 0.5)" },
  { cx: 0.2, cy: 0.8, rx: 0.45, ry: 0.4, color: "hsla(250, 60%, 82%, 0.45)" },
  { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.45, color: "hsla(200, 70%, 85%, 0.4)" },
  { cx: 0.6, cy: 0.9, rx: 0.4, ry: 0.35, color: "hsla(290, 60%, 82%, 0.4)" },
];

/** "hsla(h, s%, l%, a)" → { hsl: "hsl(h, s%, l%)", alpha: a }。把 alpha 拆给 Stop
 *  的 stopOpacity——react-native-svg 对 stopColor 里 hsla 的 alpha 处理跨版本不
 *  一致，显式拆开最稳。 */
function splitHsla(hsla: string): { hsl: string; alpha: number } {
  const m = hsla.match(/^hsla\(([^,]+),([^,]+),([^,]+),([^)]+)\)$/);
  if (!m) return { hsl: hsla, alpha: 1 };
  return {
    hsl: `hsl(${m[1].trim()}, ${m[2].trim()}, ${m[3].trim()})`,
    alpha: parseFloat(m[4]),
  };
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
  // 每个实例一套唯一 gradient id（登录页 + 聊天背景可能同时挂载，避免 url(#id)
  // 跨 Svg 撞车）。冒号在 url() 片段里不合法，去掉。
  const gid = useId().replace(/:/g, "");
  return (
    <View style={[StyleSheet.absoluteFill, styles.isolate]} pointerEvents="none">
      <Image
        source={require("../assets/bg-gradient.jpg")}
        style={[StyleSheet.absoluteFill, styles.baseImage]}
        resizeMode="cover"
      />
      {/* 静态色斑：react-native-svg 画一次，无 Blur / 无 mixBlend / 无动画。 */}
      <Svg style={StyleSheet.absoluteFill} width={w} height={h}>
        <Defs>
          {SPOTS.map((spot, i) => {
            const { hsl, alpha } = splitHsla(spot.color);
            return (
              <RadialGradient
                key={i}
                id={`${gid}-spot-${i}`}
                cx={spot.cx * w}
                cy={spot.cy * h}
                rx={spot.rx * w}
                ry={spot.ry * h}
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0" stopColor={hsl} stopOpacity={alpha} />
                <Stop offset="0.6" stopColor={hsl} stopOpacity={0} />
              </RadialGradient>
            );
          })}
        </Defs>
        {SPOTS.map((spot, i) => (
          <Ellipse
            key={i}
            cx={spot.cx * w}
            cy={spot.cy * h}
            rx={spot.rx * w}
            ry={spot.ry * h}
            fill={`url(#${gid}-spot-${i})`}
          />
        ))}
      </Svg>
      {children}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255,255,255,${veilOpacity})` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  isolate: { isolation: "isolate" },
  baseImage: { width: "100%", height: "100%", opacity: 0.6 },
});
