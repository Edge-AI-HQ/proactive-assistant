/**
 * 统一页头——web 各页共享模式：大标题（Inter 700）+ 灰副标题 + 右上
 * 双圆钮（齿轮→DebugPanel（web 同位）、汉堡→抽屉；Setting 页从抽屉进）。
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Menu, Settings } from "lucide-react-native";

import { EM_DISPLAY, tracking } from "../../ui/typography";

export default function PageHeader({
  title,
  subtitle,
  onOpenDebug,
  onOpenMenu,
}: {
  /** string 或自定义节点（NOW 的 "Hi, Name" 渐变名走节点）。 */
  title: ReactNode;
  subtitle?: ReactNode;
  onOpenDebug: () => void;
  onOpenMenu: () => void;
}) {
  return (
    <View className="flex-row items-start justify-between px-6 pt-4 pb-2">
      <View className="flex-1 pr-4">
        {typeof title === "string" ? (
          <Text
            className="text-[28px] leading-9 text-foreground"
            // web .text-display：标题统一 -0.02em 紧排。
            style={{ fontFamily: "Inter_700Bold", letterSpacing: tracking(28, EM_DISPLAY) }}
          >
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle ? (
          typeof subtitle === "string" ? (
            <Text className="mt-1 text-[13px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )
        ) : null}
      </View>
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={onOpenDebug}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open debug panel"
          className="h-10 w-10 items-center justify-center rounded-full bg-white/70 border border-white/60"
        >
          <Settings size={17} color="#3f3f46" strokeWidth={1.8} />
        </Pressable>
        <Pressable
          onPress={onOpenMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          className="h-10 w-10 items-center justify-center rounded-full bg-white/70 border border-white/60"
        >
          <Menu size={17} color="#3f3f46" strokeWidth={1.8} />
        </Pressable>
      </View>
    </View>
  );
}
