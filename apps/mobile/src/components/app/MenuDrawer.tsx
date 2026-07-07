/**
 * 全局侧边抽屉 —— 内容推移式(Claude / ChatGPT iOS 同款,用户 2026-07-04 定):
 * 不是「窄面板盖在静止页面上」,而是「当前 tab 整体被推开成一张圆角玻璃卡、菜单从
 * 底下露出」。保持右侧:页面向左滑、玻璃卡在左侧露一条(PEEK),菜单在右侧。
 *
 * 关键:玻璃卡 = 完整的 tab —— 内含 VideoBackdrop(星空视频背景,从 App.tsx root 搬进
 * 来)+ 安全区内的页面。卡不透明、全出血(FullBleedOverlay 逃出根 SafeAreaView,视频
 * 铺到刘海/home-indicator),关闭态盖住菜单、切换时整卡带背景左移。菜单层垫在卡后面
 * (淡色主题底,当前页项加较深药丸底)。
 *
 * 交互:关闭态左滑推开;打开态玻璃卡左右滑跟手 / 点玻璃卡关闭;点菜单项 = 导航 + 卡
 * 带新页滑回占满全屏(新页已由 AppShell 预挂载)。开/关跨态各一次 Haptic 震动(手势与
 * 按钮都触发)。
 *
 * 视觉:玻璃卡不缩小、只加圆角;暗罩改浅色薄玻璃(黑字变灰、彩字基本保留)。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import { ListChecks, Plug, Radio, Settings, Target, Zap } from "lucide-react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { FullBleedOverlay } from "./FullBleedOverlay";
import VideoBackdrop from "../../ui/VideoBackdrop";

export type MenuId = "now" | "ambient" | "tasks" | "connect" | "profile" | "setting";

// dev SideMenu MENU_ITEMS 同构:labelKey → common:menu.*,渲染经 t()。
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

/** 玻璃卡露出屏宽的比例(左侧一条)。 */
const PEEK = 0.28;
/** 打开时玻璃卡圆角(偏圆)。 */
const CARD_RADIUS = 40;
/** 打开时薄玻璃暗罩最大不透明度(白色薄雾:黑字变灰、彩字基本保留)。 */
const SCRIM_MAX = 0.25;
/** spring;clamp 防冲出。 */
const SPRING = { damping: 26, stiffness: 260, overshootClamping: true };
/** 松手甩速(px/s)超过它直接按方向定归宿。 */
const FLING_VELOCITY = 500;
const OPEN_ACTIVATE_X = 18;
const CLOSE_ACTIVATE_X = 10;

function clamp01(v: number): number {
  "worklet";
  return Math.min(1, Math.max(0, v));
}

/** 松手归宿:先看甩速方向,再看停在哪半边。 */
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
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /** 页面向左推的距离(露出 PEEK 一条,菜单占其余)。 */
  const pushDistance = width * (1 - PEEK);

  const progress = useSharedValue(0);
  /** 本次拖拽起点的 progress(支持半路接住)。 */
  const startP = useSharedValue(0);
  const dragging = useSharedValue(false);
  /** 手势侧最近把视觉送往的目标;effect 据此跳过重复 spring / 重复震动。 */
  const visualTarget = useRef<0 | 1>(open ? 1 : 0);

  const haptic = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

  /** 手势提交:视觉已在 UI 线程续飞,这里同步 React 状态 + 跨态震动。 */
  const commitFromGesture = (target: 0 | 1) => {
    visualTarget.current = target;
    if ((target === 1) !== open) haptic();
    if (target === 1) onRequestOpen();
    else onRequestClose();
  };

  /** 松手/取消统一收尾(worklet):spring 到归宿并带入甩速。 */
  const release = (e: { velocityX: number }) => {
    "worklet";
    if (!dragging.value) return;
    dragging.value = false;
    const target = decideTarget(progress.value, e.velocityX);
    progress.value = withSpring(target, { ...SPRING, velocity: -e.velocityX / pushDistance });
    runOnJS(commitFromGesture)(target);
  };

  // 关闭态:页面上左滑把当前页推开。竖向 ±14 内先动交还页面滚动;右滑交还页内手势。
  const openPan = Gesture.Pan()
    .enabled(!open)
    .activeOffsetX(-OPEN_ACTIVATE_X)
    .failOffsetX(OPEN_ACTIVATE_X)
    .failOffsetY([-14, 14])
    .onStart(() => {
      dragging.value = true;
      startP.value = progress.value;
    })
    .onUpdate((e) => {
      progress.value = clamp01(startP.value - e.translationX / pushDistance);
    })
    .onFinalize(release);

  // 打开态:玻璃卡左右滑跟手(可半路接住关/开)。
  const closePan = Gesture.Pan()
    .enabled(open)
    .activeOffsetX([-CLOSE_ACTIVATE_X, CLOSE_ACTIVATE_X])
    .onStart(() => {
      dragging.value = true;
      startP.value = progress.value;
    })
    .onUpdate((e) => {
      progress.value = clamp01(startP.value - e.translationX / pushDistance);
    })
    .onFinalize(release);

  // 打开态:点玻璃卡 = 关闭回原页。
  const tapClose = Gesture.Tap()
    .enabled(open)
    .onEnd(() => {
      runOnJS(onRequestClose)();
    });

  // 卡上手势:关闭态左滑推开(openPan)、打开态点卡关闭(tapClose)。收起(右滑)交给
  // 外层全屏 closePan——这样在打开后露出的「菜单区」右滑也能收起、玻璃卡顺势滑回(对齐
  // Claude);否则菜单区在卡外、没有手势层,右滑无反应。
  const cardGesture = Gesture.Race(openPan, tapClose);

  // 外部命令(汉堡 / 导航 / 点玻璃卡)→ spring 到归宿 + 跨态震动。手势已覆盖同目标时
  // 跳过(visualTarget 守卫),避免和手势 commit 双触发。
  useEffect(() => {
    const target: 0 | 1 = open ? 1 : 0;
    if (visualTarget.current === target) return;
    visualTarget.current = target;
    haptic();
    progress.value = withSpring(target, SPRING);
  }, [open, progress]);

  // 玻璃卡:仅左移 + 圆角(不缩小)。
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * pushDistance }],
    borderRadius: progress.value * CARD_RADIUS,
  }));
  // 薄玻璃暗罩:内容随打开变灰(白雾:黑字→灰,彩字基本保留)。
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * SCRIM_MAX }));

  return (
    <View style={styles.host}>
      {/* 全出血:逃出根 SafeAreaView,菜单底 + 玻璃卡视频铺到刘海/home-indicator。 */}
      <FullBleedOverlay>
        {/* 外层全屏滑动手势:打开态右滑(菜单区或卡上任意处)→ closePan 收起、玻璃卡顺势滑回
            (对齐 Claude);菜单项点按不触发 pan、照常导航。关闭态左滑推开由卡上 openPan 处理。 */}
        <GestureDetector gesture={closePan}>
          <View style={StyleSheet.absoluteFill}>
            {/* 菜单层(垫在玻璃卡底下,淡色主题底;条目在右侧露出区、避刘海)。 */}
            <View style={styles.menu}>
              <View style={[styles.menuInner, { left: width * PEEK, paddingTop: insets.top + 24 }]}>
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
                      <View style={[styles.itemRow, isActive && styles.itemRowActive]}>
                        <Icon size={18} color={isActive ? fg() : fg(0.5)} strokeWidth={isActive ? 2 : 1.5} />
                        <Text style={[styles.itemLabel, isActive && styles.itemLabelActive]}>{label}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* 玻璃卡 = VideoBackdrop(=tab 背景)+ 安全区内页面 + 变灰薄玻璃。关闭态左滑推开、
                打开态点卡关闭(cardGesture)。不透明、全出血、关闭态盖住菜单。 */}
            <GestureDetector gesture={cardGesture}>
              <Animated.View style={[styles.card, cardStyle]}>
                <VideoBackdrop />
                {/* 页面走安全区:绝对定位 top/bottom=insets 内缩(children 是 absoluteFill、会
                    忽略 padding)。 */}
                <View style={[styles.cardPages, { top: insets.top, bottom: insets.bottom }]}>
                  {children}
                </View>
                {/* 打开态 inert:透明遮挡层盖住页面(点灰卡=关闭、不误触页内按钮;触摸落
                    在遮挡层上会冒泡给玻璃卡的 tapClose/closePan,行为同前)。不再用
                    pointerEvents 翻转实现——长寿命 view 上翻转该 prop 在原生侧偶发不生效,
                    会把整树触摸钉死(Profile 首切卡死的同类嫌疑,2026-07-07 加固);条件
                    挂载/卸载走 view 插拔路径,无残留态。 */}
                {open ? <View style={StyleSheet.absoluteFill} /> : null}
                <Animated.View
                  style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}
                  pointerEvents="none"
                />
              </Animated.View>
            </GestureDetector>
          </View>
        </GestureDetector>
      </FullBleedOverlay>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  // 淡色主题底(可再调)。全出血(在 FullBleedOverlay 内)。
  menu: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "hsl(228, 30%, 96%)" },
  menuInner: { position: "absolute", right: 0, top: 0, bottom: 0, paddingHorizontal: 20 },
  // dev: px-4(16) py-3(12) gap-3(12);圆角 rounded-xl=12。
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 4,
  },
  // 当前页:较深药丸底(用户定「偏深一点」;可再调)。
  itemRowActive: { backgroundColor: fg(0.1) },
  itemLabel: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.7,
    fontFamily: "Inter_500Medium",
    color: fg(0.5),
  },
  itemLabelActive: { fontFamily: "Inter_600SemiBold", color: fg() },
  card: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.5)",
  },
  cardPages: { position: "absolute", left: 0, right: 0 },
  scrim: { backgroundColor: "#fff" },
});
