/**
 * 右侧滑出抽屉菜单——web AppLayout 菜单的 RN 对应物：整页模糊遮罩 +
 * 右侧白面板（× 关闭 + 六项大写菜单，激活项黑色高亮）+ 滑入弹簧动画。
 * 图标与 web 同名（lucide）。
 */
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import {
  CircleUserRound,
  ListChecks,
  Plug,
  Radio,
  Settings,
  X,
  Zap,
} from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

export type MenuId = "now" | "ambient" | "tasks" | "connect" | "profile" | "setting";

const ITEMS: { id: MenuId; label: string; Icon: typeof Zap }[] = [
  { id: "now", label: "NOW", Icon: Zap },
  { id: "ambient", label: "AMBIENT", Icon: Radio },
  { id: "tasks", label: "TASKS", Icon: ListChecks },
  { id: "connect", label: "CONNECT", Icon: Plug },
  { id: "profile", label: "PROFILE", Icon: CircleUserRound },
  { id: "setting", label: "SETTING", Icon: Settings },
];

const PANEL_WIDTH = 244;

export default function MenuDrawer({
  open,
  active,
  onNavigate,
  onClose,
}: {
  open: boolean;
  active: MenuId;
  onNavigate: (id: MenuId) => void;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = open
      ? withSpring(1, { damping: 22, stiffness: 220 })
      : withTiming(0, { duration: 180 });
  }, [open, progress]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * PANEL_WIDTH }],
  }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <BlurView intensity={26} tint="light" style={StyleSheet.absoluteFill} />
        </Pressable>
      </Animated.View>
      <Animated.View
        className="absolute right-0 top-0 bg-white/95"
        style={[{ width: PANEL_WIDTH, height }, panelStyle]}
      >
        <Pressable onPress={onClose} hitSlop={10} className="mt-16 ml-8">
          <X size={20} color="#71717a" strokeWidth={1.8} />
        </Pressable>
        <View className="mt-10">
          {ITEMS.map(({ id, label, Icon }) => {
            const isActive = id === active;
            return (
              <Pressable
                key={id}
                onPress={() => onNavigate(id)}
                className="flex-row items-center gap-3 px-8 py-3.5"
              >
                <Icon
                  size={18}
                  color={isActive ? "#111114" : "#9494a0"}
                  strokeWidth={isActive ? 2.2 : 1.8}
                />
                <Text
                  className={isActive ? "text-[13px] tracking-[2px] text-foreground" : "text-[13px] tracking-[2px] text-muted-foreground"}
                  style={{ fontFamily: isActive ? "Inter_700Bold" : "Inter_500Medium" }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>
    </View>
  );
}
