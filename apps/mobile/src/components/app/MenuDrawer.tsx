/**
 * 全局侧边抽屉（右侧滑出）—— 视觉逐字对齐 dev `SideMenu.tsx`，手势保留
 * ChatGPT 级跟手范式（MenuDrawerHost 包住整个页面栈）：
 *
 * 视觉（dev 真源）：面板 w-56=224、fixed top-0 bottom-0 **竖直全出血**（RN 用
 * ChatSheet 同款负 inset 逃出 SafeAreaView，刘海/home-indicator 全覆盖）；
 * 蒙层 = bg-foreground/10 + backdrop-blur-sm(4px→BlurView 8)；面板 = 白渐变
 * 180°(0.85→0.95) + blur(48→BlurView 75) + 左缘 white/50 边；内容 pt-14 px-5，
 * X(20/1.5 fg60, p-1.5 圆底 press fg/8) + 条目（px-4 py-3 rounded-xl=12,
 * 激活=fg/8 药丸底+fg 全色+粗 stroke, 未激活=fg/50, 文字 14/tracking-wider）。
 *
 * 手势：
 * - 关闭态：任意页面任意位置左滑跟手拉出（progress 1:1 吃手指位移）。页面内横向
 *   交互面（球面/pager/进度条）RNGH 仲裁天然优先；球面负 hitSlop 让出右缘。
 * - 打开态：整屏右滑跟手关闭（面板/蒙层皆可，可半路接住），蒙层点按也关。
 * - 松手 = 位置 + 甩动速度定归宿，velocity 无缝带入 spring（dev 同参 300/28）；
 *   跨越开/关的提交瞬间轻触觉。
 * - 单一动画驱动：手势在 UI 线程直接续 spring 并记 visualTarget；effect 只响应
 *   外部命令（汉堡/导航/蒙层点按）且目标未被手势覆盖时才起 spring。
 *
 * ⚠️ 本仓 NativeWind 会吞 Pressable 的 style prop——所有可按元素一律
 * children-as-function + 内层 View 承载样式（SettingScreen BackButton 同款）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import {
  ListChecks,
  Plug,
  Radio,
  Settings,
  Target,
  X,
  Zap,
} from "lucide-react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { FullBleedOverlay } from "./FullBleedOverlay";

export type MenuId = "now" | "ambient" | "tasks" | "connect" | "profile" | "setting";

// dev SideMenu MENU_ITEMS 同构：labelKey → common:menu.*，渲染经 t()。
const ITEMS = [
  { id: "now", labelKey: "menu.now", Icon: Zap },
  { id: "ambient", labelKey: "menu.ambient", Icon: Radio },
  { id: "tasks", labelKey: "menu.tasks", Icon: ListChecks },
  { id: "connect", labelKey: "menu.connect", Icon: Plug },
  { id: "profile", labelKey: "menu.profile", Icon: Target },
  { id: "setting", labelKey: "menu.setting", Icon: Settings },
] as const;

/** token --foreground: 230 25% 15%。 */
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);

/** dev SideMenu 面板宽：w-56 = 224px。 */
const PANEL_WIDTH = 224;
/** dev SideMenu 同参 spring(damping 28, stiffness 300)；clamp 防面板冲出屏缘露缝。 */
const SPRING = { damping: 28, stiffness: 300, overshootClamping: true };
/** 松手甩速（px/s）超过它直接按方向定归宿，不看位置。 */
const FLING_VELOCITY = 500;
/** 左滑拉出的激活门槛：横向位移 18px（竖向 ±14 内漂移交还页面滚动）。 */
const OPEN_ACTIVATE_X = 18;
const CLOSE_ACTIVATE_X = 10;

function clamp01(v: number): number {
  "worklet";
  return Math.min(1, Math.max(0, v));
}

/** 松手归宿：先看甩速方向，再看停在哪半边。 */
function decideTarget(p: number, velocityX: number): 0 | 1 {
  "worklet";
  if (velocityX < -FLING_VELOCITY) return 1;
  if (velocityX > FLING_VELOCITY) return 0;
  return p > 0.5 ? 1 : 0;
}

export default function MenuDrawerHost({
  open,
  active,
  children,
  onRequestOpen,
  onRequestClose,
  onNavigate,
}: {
  open: boolean;
  active: MenuId;
  children: ReactNode;
  onRequestOpen: () => void;
  onRequestClose: () => void;
  onNavigate: (id: MenuId) => void;
}) {
  const { t } = useTranslation();

  const progress = useSharedValue(0);
  /** 本次拖拽起点的 progress（支持半路接住飞行中的面板）。 */
  const startP = useSharedValue(0);
  const dragging = useSharedValue(false);
  // overlay 挂载态：拖拽激活即挂（面板要在手指下出现），关闭动画播完才卸。
  const [mounted, setMounted] = useState(open);
  // 手势侧最近把视觉送往的目标；effect 据此跳过重复 spring。
  const visualTarget = useRef<0 | 1>(open ? 1 : 0);

  const mountOverlay = () => setMounted(true);
  const unmountOverlay = () => setMounted(false);

  /** 手势提交：视觉已在 UI 线程续飞，这里只同步 React 状态 + 跨态触觉。 */
  const commitFromGesture = (target: 0 | 1) => {
    visualTarget.current = target;
    if ((target === 1) !== open) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (target === 1) onRequestOpen();
    else onRequestClose();
  };

  /** 松手/被取消统一收尾（worklet）：spring 到归宿并带入甩速。 */
  const release = (e: { velocityX: number }) => {
    "worklet";
    if (!dragging.value) return;
    dragging.value = false;
    const target = decideTarget(progress.value, e.velocityX);
    progress.value = withSpring(
      target,
      { ...SPRING, velocity: -e.velocityX / PANEL_WIDTH },
      (finished) => {
        if (finished && target === 0) runOnJS(unmountOverlay)();
      },
    );
    runOnJS(commitFromGesture)(target);
  };

  // 关闭态：页面栈上的全局左滑拉出。竖向 ±14 内先动交还页面滚动；右滑交还
  // 页内手势（Setting 子页的滑动返回等）。
  const openPan = Gesture.Pan()
    .activeOffsetX(-OPEN_ACTIVATE_X)
    .failOffsetX(OPEN_ACTIVATE_X)
    .failOffsetY([-14, 14])
    .onStart(() => {
      dragging.value = true;
      startP.value = progress.value;
      runOnJS(mountOverlay)();
    })
    .onUpdate((e) => {
      progress.value = clamp01(startP.value - e.translationX / PANEL_WIDTH);
    })
    .onFinalize(release);

  // 打开态：整屏（蒙层 + 面板）右滑跟手关闭。
  const closePan = Gesture.Pan()
    .activeOffsetX(CLOSE_ACTIVATE_X)
    .onStart(() => {
      dragging.value = true;
      startP.value = progress.value;
    })
    .onUpdate((e) => {
      progress.value = clamp01(startP.value - e.translationX / PANEL_WIDTH);
    })
    .onFinalize(release);

  // 外部命令（汉堡 / 导航 / 蒙层点按）→ spring；手势已覆盖同目标时跳过。
  useEffect(() => {
    const target: 0 | 1 = open ? 1 : 0;
    if (open) setMounted(true);
    if (visualTarget.current === target) return;
    visualTarget.current = target;
    progress.value = withSpring(target, SPRING, (finished) => {
      if (finished && target === 0) runOnJS(unmountOverlay)();
    });
  }, [open, progress]);

  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * PANEL_WIDTH }],
  }));

  return (
    <View style={styles.host}>
      {/* 用户定：不做内容视差（tab 页保持原位），蒙层模糊保留。 */}
      <GestureDetector gesture={openPan}>
        <View style={styles.pages}>{children}</View>
      </GestureDetector>
      {mounted ? (
        <FullBleedOverlay>
          {/* closePan 包整块出血区（蒙层 + 面板皆可右滑关）；absoluteFill 撑满
              FullBleedOverlay 的出血 root（顶到刘海、底到 home-indicator）。 */}
          <GestureDetector gesture={closePan}>
            <View style={StyleSheet.absoluteFill}>
              {/* dev 蒙层：bg-foreground/10 + backdrop-blur-sm(4px)。 */}
              <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
                <Pressable onPress={onRequestClose} className="absolute inset-0">
                  <BlurView intensity={8} tint="light" style={StyleSheet.absoluteFill} />
                  <View style={[StyleSheet.absoluteFill, styles.scrimTint]} />
                </Pressable>
              </Animated.View>
              {/* dev 面板：白渐变 180°(0.85→0.95) + blur(48) + 左缘 white/50 边。 */}
              <Animated.View style={[styles.panel, panelStyle]}>
                <BlurView intensity={75} tint="light" style={StyleSheet.absoluteFill} />
                <LinearGradient
                  colors={["rgba(255,255,255,0.85)", "rgba(255,255,255,0.95)"]}
                  style={StyleSheet.absoluteFill}
                />
                {/* dev: pt-14 px-5；X 钮 p-1.5 圆底 mb-8。 */}
                <View style={styles.panelContent}>
                  <Pressable onPress={onRequestClose} hitSlop={6} accessibilityRole="button">
                    <View style={styles.closeButton}>
                      <X size={20} color={fg(0.6)} strokeWidth={1.5} />
                    </View>
                  </Pressable>
                  <View style={styles.items}>
                    {/* 用户实测 dev：激活/按压均无背景变化，只有字色 fg50→fg + 字重
                        medium→semibold + icon stroke 1.5→2（源码里的 bg-foreground/8
                        /hover:bg-foreground/4 是死类，本版 Tailwind 不编译）。 */}
                    {ITEMS.map(({ id, labelKey, Icon }) => {
                      const isActive = id === active;
                      const label = t(labelKey);
                      return (
                        <Pressable
                          key={id}
                          onPress={() => onNavigate(id)}
                          accessibilityRole="button"
                          accessibilityLabel={label}
                        >
                          <View style={styles.itemRow}>
                            <Icon
                              size={18}
                              color={isActive ? fg() : fg(0.5)}
                              strokeWidth={isActive ? 2 : 1.5}
                            />
                            <Text style={[styles.itemLabel, isActive && styles.itemLabelActive]}>
                              {label}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </Animated.View>
            </View>
          </GestureDetector>
        </FullBleedOverlay>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  pages: { flex: 1 },
  scrimTint: { backgroundColor: fg(0.1) },
  panel: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: PANEL_WIDTH,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(255,255,255,0.5)",
    overflow: "hidden",
  },
  // dev: pt-14(56，自物理屏顶；WKWebView viewport-fit=cover 同基准) px-5(20)。
  panelContent: { paddingTop: 56, paddingHorizontal: 20 },
  // dev: p-1.5(6) rounded-full mb-8(32)。
  closeButton: {
    alignSelf: "flex-start",
    padding: 6,
    borderRadius: 999,
    marginBottom: 32,
  },
  items: { gap: 4 }, // dev: flex-col gap-1
  // dev: px-4(16) py-3(12) gap-3(12)。
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  // dev: text-sm(14) tracking-wider(0.05em≈0.7px)，active font-semibold / 默认 medium。
  itemLabel: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.7,
    fontFamily: "Inter_500Medium",
    color: fg(0.5),
  },
  itemLabelActive: {
    fontFamily: "Inter_600SemiBold",
    color: fg(),
  },
});
