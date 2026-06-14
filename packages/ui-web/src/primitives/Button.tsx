import { cn, buttonVariants, BUTTON_TEXT_COLOR, BUTTON_TEXT_VARIANT } from "@pin-ai/ui-kit";
import type { ButtonProps, ButtonVariant } from "@pin-ai/ui-kit";

import { Text } from "./Text";

/** 各 variant 的 hover 态（web-only;RN 无 hover，故不进 cva 双端配方）。 */
const VARIANT_HOVER: Record<ButtonVariant, string> = {
  primary: "hover:bg-foreground/85",
  secondary: "hover:bg-muted/80",
  ghost: "hover:bg-foreground/5",
  danger: "hover:bg-red-600",
};

/**
 * Button primitive — web 实现（`<button>`）。
 *
 * 布局/背景/尺寸走 ui-kit `buttonVariants` cva 配方（双端共享）;文字走内部 Text
 * （双端字重/字号/色，不靠 CSS 继承）;web 特有的 transition/cursor/disabled 在此追加。
 * 契约见 @pin-ai/ui-kit `ButtonProps`;RN 实现见 apps/mobile/src/primitives/Button。
 */
export function Button({
  variant,
  size,
  disabled,
  className,
  onPress,
  type = "button",
  leftIcon,
  rightIcon,
  children,
}: ButtonProps) {
  const v = variant ?? "primary";
  const s = size ?? "md";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        // web 需要显式 display：cva base 的 flex-row 在 RN(默认 flex)生效，但 web
        // 上 flex-row 不带 inline-flex 无效 → 退回 inline-block、icon+text 堆叠。
        // inline-flex 是 web 专属增强，与 hover/transition 一样在实现层追加。
        "inline-flex",
        buttonVariants({ variant: v, size: s }),
        VARIANT_HOVER[v],
        "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
    >
      {leftIcon}
      {children != null && (
        <Text variant={BUTTON_TEXT_VARIANT[s]} weight="semibold" className={BUTTON_TEXT_COLOR[v]}>
          {children}
        </Text>
      )}
      {rightIcon}
    </button>
  );
}
