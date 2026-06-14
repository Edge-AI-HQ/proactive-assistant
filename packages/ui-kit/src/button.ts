import type { ReactNode } from "react";

import { cva, type VariantProps } from "class-variance-authority";

import type { TypeScaleKey } from "@pin-ai/design";

/**
 * Button variant 配方（双端共享，仅用 NativeWind 通用 class 子集）。
 * web 特有的 transition / cursor / hover / disabled: 由 web 实现追加，不进配方。
 */
export const buttonVariants = cva(
  "flex-row items-center justify-center gap-1.5 rounded-xl",
  {
    variants: {
      variant: {
        primary: "bg-foreground",
        secondary: "bg-muted",
        ghost: "",
        danger: "bg-red-500",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
        lg: "h-11 px-5",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/** 文字色随 variant（双端实现各自把它给内部 Text —— RN 不继承 CSS 色，必须显式）。 */
export const BUTTON_TEXT_COLOR: Record<ButtonVariant, string> = {
  primary: "text-background",
  secondary: "text-foreground",
  ghost: "text-foreground",
  danger: "text-white",
};

/** size → 文字字号档（typeScale）。 */
export const BUTTON_TEXT_VARIANT: Record<ButtonSize, TypeScaleKey> = {
  sm: "bodySm",
  md: "bodySm",
  lg: "body",
};

/**
 * Button primitive 契约（双端共享，平台无关）。
 * web 实现 = ui-web/primitives/Button，RN 实现 = apps/mobile/primitives/Button。
 * 文字走内部 Text（双端字重/字号/色正确，不靠 CSS 继承——RN 不继承）;icon 经
 * leftIcon/rightIcon。设计 SSOT：docs/plans/2026-06-13-dual-platform-design-system.mdx。
 */
export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  disabled?: boolean;
  className?: string;
  /** 双端统一事件（web→onClick / RN→onPress）。 */
  onPress?: () => void;
  /** 仅 web：button 的 type。 */
  type?: "button" | "submit" | "reset";
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  children?: ReactNode;
}
