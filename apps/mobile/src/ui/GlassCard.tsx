/**
 * 玻璃卡片基类——web `.glass-card` / `.glass-card-strong` 的 RN 对应物。
 * web 真源（proactive-ai-frontend/src/index.css @layer components）：
 *   regular: bg white/45 + border white/50 + blur(32px) saturate(1.3)
 *            + shadow `0 4px 24px hsla(280,20%,60%,.06)` + inset 顶高光 white/30
 *   strong : bg white/60 + border white/65 + blur(48px) saturate(1.5)
 *            + shadow `0 4px 20px` 同色 + inset white/40
 * RN 介质映射：backdrop-filter → expo-blur（iOS UIVisualEffectView，light
 * tint 自带 saturate 增益）；inset 高光 → RN 0.76+ boxShadow inset；外影
 * 不能进 overflow:hidden 的裁剪层，所以阴影挂外层、blur/border 挂内裁剪层。
 * 性能红线：每屏常驻 BlurView 控制在个位数；球面卡片云暂不接本组件。
 */
import type { PropsWithChildren } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import { BlurView } from "expo-blur";

/** 真机校准点：intensity ↔ web blur px 无线性公式，底色补偿 light tint 自带的白。 */
const VARIANTS = {
  regular: {
    intensity: 50,
    overlay: "rgba(255,255,255,0.28)",
    border: "rgba(255,255,255,0.5)",
    outerShadow: "0 4px 24px hsla(280, 20%, 60%, 0.06)",
    insetHighlight: "inset 0 1px 0 rgba(255,255,255,0.3)",
  },
  strong: {
    intensity: 75,
    overlay: "rgba(255,255,255,0.42)",
    border: "rgba(255,255,255,0.65)",
    outerShadow: "0 4px 20px hsla(280, 20%, 60%, 0.06)",
    insetHighlight: "inset 0 1px 0 rgba(255,255,255,0.4)",
  },
} as const;

const RADIUS = 24; // rounded-3xl

export function GlassCard({
  strong = false,
  className = "",
  style,
  children,
  ...rest
}: PropsWithChildren<ViewProps & { strong?: boolean; className?: string }>) {
  const v = VARIANTS[strong ? "strong" : "regular"];
  return (
    <View
      className={`rounded-3xl ${className}`}
      style={[{ boxShadow: v.outerShadow }, style]}
      {...rest}
    >
      <View style={styles.clip} pointerEvents="none">
        <BlurView
          intensity={v.intensity}
          tint="light"
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: v.overlay,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: v.border,
              borderRadius: RADIUS,
              boxShadow: v.insetHighlight,
            },
          ]}
        />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: RADIUS,
    overflow: "hidden",
  },
});
