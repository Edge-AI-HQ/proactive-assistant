import { View, Pressable, type ViewStyle } from "react-native";

import { cn, surfaceVariants } from "@pin-ai/ui-kit";
import type { SurfaceProps } from "@pin-ai/ui-kit";
import { elevation as elevationTokens } from "@pin-ai/design";

/**
 * Surface primitive — RN 实现（View / 可点击 Pressable）。
 *
 * 布局/背景走同一 `surfaceVariants` cva 配方;elevation 投影成 RN shadow*+android
 * elevation。glass variant 的真模糊需 expo-blur（BlurView 包裹），第一版仅走配方的
 * 半透明边框，真机模糊待后续接入（见 plan 介质映射）。
 * web 实现见 packages/ui-web/src/primitives/Surface。
 */
export function Surface({ variant, elevation, className, onPress, children }: SurfaceProps) {
  const v = variant ?? "solid";
  let style: ViewStyle | undefined;
  if (elevation) {
    const e = elevationTokens[elevation];
    style = {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: e.y },
      shadowOpacity: e.opacity,
      shadowRadius: e.blur / 2,
      elevation: Math.round(e.y + e.blur / 4),
    };
  }
  const cls = cn(surfaceVariants({ variant: v }), className);
  if (onPress) {
    return (
      <Pressable onPress={onPress} className={cls} style={style}>
        {children}
      </Pressable>
    );
  }
  return (
    <View className={cls} style={style}>
      {children}
    </View>
  );
}
