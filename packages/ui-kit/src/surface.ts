import type { ReactNode } from "react";

import { cva, type VariantProps } from "class-variance-authority";

import type { ElevationKey } from "@pin-ai/design";

/** Surface variant 配方（双端共享，仅 NativeWind 通用 class 子集）。 */
export const surfaceVariants = cva("rounded-2xl", {
  variants: {
    variant: {
      solid: "bg-card border border-border",
      elevated: "bg-card",
      glass: "border border-white/60",
    },
  },
  defaultVariants: { variant: "solid" },
});

export type SurfaceVariant = NonNullable<VariantProps<typeof surfaceVariants>["variant"]>;

/**
 * Surface primitive 契约（双端共享）。卡片/面板容器。web 实现 = ui-web/primitives/Surface
 * （glass 用 backdrop-filter）;RN 实现 = apps/mobile（glass 用 expo-blur）。
 * elevation 走 elevation token，各端投影成 boxShadow / RN shadow。
 */
export interface SurfaceProps extends VariantProps<typeof surfaceVariants> {
  /** 阴影档（elevation token）。 */
  elevation?: ElevationKey;
  className?: string;
  /** 有则可点击（web→button / RN→Pressable）。 */
  onPress?: () => void;
  children?: ReactNode;
}
