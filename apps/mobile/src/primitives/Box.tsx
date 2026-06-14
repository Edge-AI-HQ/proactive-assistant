import { View, Pressable } from "react-native";

import type { BoxProps } from "@pin-ai/ui-kit";

/**
 * Box primitive — RN 实现（View / 可点击 Pressable）。
 * 纯容器,无样式默认;需要双端一致的 flex 布局用 Stack。
 * web 实现见 packages/ui-web/src/primitives/Box。
 */
export function Box({ className, onPress, children }: BoxProps) {
  if (onPress) {
    return (
      <Pressable onPress={onPress} className={className}>
        {children}
      </Pressable>
    );
  }
  return <View className={className}>{children}</View>;
}
