/**
 * 玻璃卡片基类——参考 **dev**(proactive-ai-frontend 经 Capacitor build 到 iOS 的实际渲染),
 * 不是 **web**(浏览器)。dev 上 native-power-save(packages/ui-web/src/auth/platform.ts:72,
 * isNative 时永远开)砍掉 backdrop-filter → web 的 `.glass-card{,-strong}` 在 native 上只剩
 * 同一条半透明白渐变(blur 没了,strong / regular 长一样)→ 背景云朵 **sharp 透出**。
 * web(浏览器)反而因为 backdrop-filter blur(40px) 把视频磨成一片、看不出云朵——那不是参考对象。
 *
 * 所以这里照 dev 渲染:135° 半透明渐变(0.55→0.25,让云朵透出)+ 1px 白边 + inset 顶高光 +
 * 轻外影,**不用 BlurView**(dev 无 blur;BlurView 的 light tint 自带白会把云朵盖死 = test 之前不透的根因)。
 */
import type { PropsWithChildren } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

// dev `.glass-card` / `.glass-card-strong` 同一 recipe(native 砍 backdrop-filter 后无 blur 差异):
//   background: linear-gradient(135deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.25) 100%)
//   border: 1px solid rgba(255,255,255,.45)
//   box-shadow: inset 0 1px 1px rgba(255,255,255,.6), 0 4px 16px rgba(0,0,0,.04), 0 1px 4px rgba(0,0,0,.02)
const GRADIENT = ["rgba(255,255,255,0.55)", "rgba(255,255,255,0.25)"] as const;
const BORDER = "rgba(255,255,255,0.45)";
const OUTER_SHADOW = "0 4px 16px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.02)";
const INSET_HIGHLIGHT = "inset 0 1px 1px rgba(255,255,255,0.6)";
const RADIUS = 24; // rounded-3xl

export function GlassCard({
  // dev(native)上 strong 与 regular 渲染一致(无 blur 差异)→ strong 不再改变外观,
  // 仅保留 prop 兼容现有调用方(同时把它从 ...rest 摘掉,避免漏传给 <View>)。
  strong: _strong = false,
  radius = RADIUS,
  className = "",
  style,
  children,
  ...rest
}: PropsWithChildren<ViewProps & { strong?: boolean; radius?: number; className?: string }>) {
  return (
    <View
      className={className}
      style={[{ borderRadius: radius, boxShadow: OUTER_SHADOW }, style]}
      {...rest}
    >
      <View style={[styles.clip, { borderRadius: radius }]} pointerEvents="none">
        {/* dev: 半透明白渐变(无 backdrop-filter)→ 背景云朵 sharp 透出 */}
        <LinearGradient
          colors={GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {/* 1px 白边 + inset 顶高光 */}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: BORDER,
              borderRadius: radius,
              boxShadow: INSET_HIGHLIGHT,
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
    overflow: "hidden",
  },
});
