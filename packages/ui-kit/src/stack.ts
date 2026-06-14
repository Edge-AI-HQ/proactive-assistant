import type { ReactNode } from "react";

import { cva, type VariantProps } from "class-variance-authority";

/**
 * Stack variant 配方（双端共享，仅 NativeWind 通用 class 子集）。
 * flex 容器:direction / align / justify / gap。
 *
 * gap 用 Tailwind 内置 spacing scale 的**静态档**（cva 字面量,content 扫得到;
 * design token 暂无 spacing,两端均 tailwindcss 3.4 同源内置 scale → gap-2 双端都
 * 是 8px）。direction 显式 row/col:web `<div>` 默认 block、RN `<View>` 默认 flex-col,
 * 显式声明保证双端一致。
 */
export const stackVariants = cva("flex", {
  variants: {
    direction: { row: "flex-row", col: "flex-col" },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      stretch: "items-stretch",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
      between: "justify-between",
    },
    gap: {
      none: "gap-0",
      xs: "gap-1",
      sm: "gap-2",
      md: "gap-4",
      lg: "gap-6",
      xl: "gap-8",
    },
  },
  defaultVariants: { direction: "col", align: "stretch", justify: "start", gap: "none" },
});

export type StackDirection = NonNullable<VariantProps<typeof stackVariants>["direction"]>;
export type StackAlign = NonNullable<VariantProps<typeof stackVariants>["align"]>;
export type StackJustify = NonNullable<VariantProps<typeof stackVariants>["justify"]>;
export type StackGap = NonNullable<VariantProps<typeof stackVariants>["gap"]>;

/**
 * Stack primitive 契约（双端共享）。VStack/HStack/Spacer 由各端实现层基于 Stack 派生
 * （VStack=direction col / HStack=direction row / Spacer=flex-1 占位）。
 * web 实现 = ui-web/primitives/Stack，RN 实现 = apps/mobile/primitives/Stack。
 */
export interface StackProps extends VariantProps<typeof stackVariants> {
  className?: string;
  /** 有则可点击（web→onClick / RN→Pressable）。 */
  onPress?: () => void;
  children?: ReactNode;
}
