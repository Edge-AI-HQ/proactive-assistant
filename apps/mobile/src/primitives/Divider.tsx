import { View } from "react-native";

import { cn, dividerVariants } from "@pin-ai/ui-kit";
import type { DividerProps } from "@pin-ai/ui-kit";

/**
 * Divider primitive — RN 实现（View）。
 * 走与 web 同一 `dividerVariants` cva 配方;色用 border token。
 * web 实现见 packages/ui-web/src/primitives/Divider。
 */
export function Divider({ orientation, className }: DividerProps) {
  return <View className={cn(dividerVariants({ orientation }), className)} />;
}
