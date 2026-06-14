import { View, Pressable } from "react-native";

import { cn, stackVariants } from "@pin-ai/ui-kit";
import type { StackProps } from "@pin-ai/ui-kit";

/**
 * Stack primitive — RN 实现（flex View / 可点击 Pressable）。
 * 布局走与 web 同一 `stackVariants` cva 配方（NativeWind className）。
 * web 实现见 packages/ui-web/src/primitives/Stack。
 */
export function Stack({ direction, align, justify, gap, className, onPress, children }: StackProps) {
  const cls = cn(stackVariants({ direction, align, justify, gap }), className);
  if (onPress) {
    return (
      <Pressable onPress={onPress} className={cls}>
        {children}
      </Pressable>
    );
  }
  return <View className={cls}>{children}</View>;
}

export function VStack(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="col" />;
}

export function HStack(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="row" />;
}

/** flex-1 占位,把 Stack 中其余项推开。 */
export function Spacer({ className }: { className?: string }) {
  return <View className={cn("flex-1", className)} />;
}
