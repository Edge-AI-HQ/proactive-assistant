/**
 * 玻璃卡片基类——web `.glass-card` / `.glass-card-strong` 的 RN 对应物
 * （半透白 + 发丝边 + 柔和投影；strong 更实更亮）。RN 无 backdrop-blur
 * 的廉价等价物（BlurView 大面积成本高），用提高底色不透明度近似——与
 * web native-power-save 降级路径一致。
 */
import type { PropsWithChildren } from "react";
import { View, type ViewProps } from "react-native";

export function GlassCard({
  strong = false,
  className = "",
  children,
  ...rest
}: PropsWithChildren<ViewProps & { strong?: boolean; className?: string }>) {
  return (
    <View
      className={`rounded-3xl border ${
        strong ? "bg-white/80 border-white/70" : "bg-white/55 border-white/60"
      } ${className}`}
      style={{
        shadowColor: "hsl(280, 20%, 60%)",
        shadowOpacity: 0.06,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
      }}
      {...rest}
    >
      {children}
    </View>
  );
}
