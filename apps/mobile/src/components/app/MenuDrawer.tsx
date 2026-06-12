/**
 * 右侧滑出抽屉菜单——web AppLayout 菜单的 RN 对应物：整页模糊遮罩 +
 * 右侧白面板（× 关闭 + 六项大写菜单，激活项黑色高亮）+ 滑入弹簧动画。
 * 图标与 web 同名（lucide）。
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
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
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

export type MenuId = "now" | "ambient" | "tasks" | "connect" | "profile" | "setting";

const styles = StyleSheet.create({
  panel: {
    overflow: "hidden",
    borderLeftWidth: 1,
    borderLeftColor: "rgba(255,255,255,0.5)",
  },
});

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
  // 退场动画播完再卸载（open=false 即 return null 会让 180ms 退场瞬切）。
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // web SideMenu 同款 spring 参数；overshootClamping 截掉过冲——
      // 不然 d28/s300（阻尼比≈0.81）会把面板弹出左缘再回弹（弹跳感）。
      progress.value = withSpring(1, { damping: 28, stiffness: 300, overshootClamping: true });
    } else {
      progress.value = withTiming(0, { duration: 180 }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [open, progress]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * PANEL_WIDTH }],
  }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  // web SideMenu 同款：面板上右滑关闭（跟手，progress 直接吃手指位移）。
  const swipeClose = Gesture.Pan()
    .activeOffsetX(10)
    .onUpdate((e) => {
      progress.value = Math.min(1, Math.max(0, 1 - e.translationX / PANEL_WIDTH));
    })
    .onEnd((e) => {
      if (e.translationX > PANEL_WIDTH / 3 || e.velocityX > 500) {
        runOnJS(onClose)();
      } else {
        progress.value = withSpring(1, { damping: 28, stiffness: 300, overshootClamping: true });
      }
    });

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <BlurView intensity={26} tint="light" style={StyleSheet.absoluteFill} />
        </Pressable>
      </Animated.View>
      <GestureDetector gesture={swipeClose}>
      <Animated.View
        className="absolute right-0 top-0"
        style={[styles.panel, { width: PANEL_WIDTH, height }, panelStyle]}
      >
        {/* web 面板介质：blur(48px) + 白渐变 180°(0.85→0.95) + 左缘 white/50 边。 */}
        <BlurView intensity={75} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={["rgba(255,255,255,0.85)", "rgba(255,255,255,0.95)"]}
          style={StyleSheet.absoluteFill}
        />
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
                accessibilityRole="button"
                accessibilityLabel={label}
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
      </GestureDetector>
    </View>
  );
}
