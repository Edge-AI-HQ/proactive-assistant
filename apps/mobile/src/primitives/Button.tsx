import { Pressable } from "react-native";

import { cn, buttonVariants, BUTTON_TEXT_COLOR, BUTTON_TEXT_VARIANT } from "@pin-ai/ui-kit";
import type { ButtonProps } from "@pin-ai/ui-kit";

import { Text } from "./Text";

/**
 * Button primitive — RN 实现（Pressable）。
 *
 * 布局/背景走与 web 同一 `buttonVariants` cva 配方;文字走 RN Text（双端字重/色）;
 * onPress 原生事件;web 的 `type` prop 在 RN 无意义、忽略。
 * web 实现见 packages/ui-web/src/primitives/Button。
 */
export function Button({
  variant,
  size,
  disabled,
  className,
  onPress,
  leftIcon,
  rightIcon,
  children,
}: ButtonProps) {
  const v = variant ?? "primary";
  const s = size ?? "md";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(buttonVariants({ variant: v, size: s }), disabled ? "opacity-50" : "", className)}
    >
      {leftIcon}
      {children != null && (
        <Text variant={BUTTON_TEXT_VARIANT[s]} weight="semibold" className={BUTTON_TEXT_COLOR[v]}>
          {children}
        </Text>
      )}
      {rightIcon}
    </Pressable>
  );
}
