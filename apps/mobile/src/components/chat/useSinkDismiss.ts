/**
 * 聊天 sheet 的「右滑下沉退出」手势 —— main chat 与 card chat 统一用这一份，保证
 * 两个聊天进出体感完全一致（对齐 web ChatSheetOverlay：rightward drag → downward
 * sink，露出底下的实时页面）。
 *
 * 与早期「左缘 20px 条」做法的区别（本次按行业标准重做）：
 *  - **任意处可滑**：手势包裹整张 sheet，不再限定左缘窄条（main chat 之前不响应就
 *    是因为只有那条窄条触发）。
 *  - **和竖直滚动共存**：`activeOffsetX(16)` 只在右滑 ≥16px 时激活；`failOffsetY`
 *    在竖直先动 ≥20px 时才让手势失败，把竖直交还给聊天列表 / landing 滚动
 *    （FAIL_Y 略大于 ACTIVATE_X，见下方常量注释）。
 *  - 跟手 1:1（onUpdate 直接写 y，无中间动画）；松手过阈值（0.35 屏宽 或 vx>400）
 *    才提交退出，否则 spring 回弹（= web 同参数）。
 *
 * 键盘时序（2026-07-07 用户定）：开着键盘右滑时，**手势一激活键盘就开始自然收起**；
 * 松手提交时若键盘还没收完，页面停在松手位等键盘完全收好再挤出（dismiss() 的
 * Promise 在键盘完全隐藏时 resolve）——先键盘、后页面，永远不带着键盘滑出去。
 */
import { useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  KeyboardController,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/** 面板下沉距离 / 手指右移距离。>1 = 沉得比手指快一点（web SINK_RATIO 同值）。 */
const SINK_RATIO = 1.5;
/** 松手时：右移超 0.35 屏宽 或 横向速度 >400 即提交退出，否则回弹。 */
const COMMIT_DISTANCE_FRACTION = 0.35;
const COMMIT_VELOCITY = 400;
/**
 * 右滑 ≥16px 激活手势；竖直先动 ≥20px 才让位给列表滚动。
 * FAIL_Y 要「略」大于 ACTIVATE_X，不是数倍：
 *  - 老值 12<16：自然右滑带一点竖直弧度，竖直先越阈 → 手势自杀 =「右滑常变上下翻页」。
 *  - 放太大（如 40）：带点右斜的正常竖直滚动（>22° 斜）会被误判成退出、把滚动吃掉。
 * 判定边界 = atan(ACTIVATE_X/FAIL_Y) ≈ 39° 偏离竖直：明显右滑激活退出、近竖直滚动让位
 * （和同仓 SwipeBackLayer 的 16/20≈同比例一致）。真机可在 18~24 间微调 FAIL_Y。
 */
const ACTIVATE_X = 16;
const FAIL_Y = 20;

/** 键盘 progress 视为「可见」的下限（0=全收 1=全开；避免浮点尾巴误判）。 */
const KB_VISIBLE_EPS = 0.01;

/** 先收键盘、收完再触发关闭（键盘本就没开时 dismiss() 立即 resolve，等价直接关）。
 *  给 sheet 的 ←/︾ 等关闭按钮用，和右滑手势的时序保持一致。 */
export function dismissKeyboardThenClose(onClose: () => void) {
  void KeyboardController.dismiss().then(onClose);
}

export function useSinkDismissGesture(
  y: SharedValue<number>,
  height: number,
  width: number,
  onClose: () => void,
  /**
   * 阈值覆盖。左缘窄条模式（ChatSheet / CardChatScreen 的 24px 边条）用更紧的值：
   * 边条是孤立区、右侧没有竖滚要仲裁，activateX 小一点更好起拖（对齐同仓
   * SwipeBackLayer 的 10/12）。不传 = 内容整幅默认（16/20，仍要让位竖滚）。
   */
  opts?: { activateX?: number; failY?: number },
) {
  const activateX = opts?.activateX ?? ACTIVATE_X;
  const failY = opts?.failY ?? FAIL_Y;
  // 键盘位置（UI 线程共享值，0=收起）：手势起手收键盘、松手判断要不要等它收完。
  const { progress: kbProgress } = useReanimatedKeyboardAnimation();
  return useMemo(() => {
    // runOnJS 只传无参函数（跨线程传函数实参不可靠），回调在 JS 侧先组好。
    const startKeyboardDismiss = () => void KeyboardController.dismiss();
    const closeAfterKeyboard = () => dismissKeyboardThenClose(onClose);
    return Gesture.Pan()
      .activeOffsetX(activateX)
      .failOffsetY([-failY, failY])
      .onStart(() => {
        // 手指一开始滑就让键盘自然收起（用户定的时序）；没开键盘时不打 JS 往返。
        if (kbProgress.value > KB_VISIBLE_EPS) {
          runOnJS(startKeyboardDismiss)();
        }
      })
      .onUpdate((e) => {
        // 右移 → 下沉，跟手（clamp 0：往回拖不把面板顶过屏顶）。
        y.value = Math.max(0, e.translationX * SINK_RATIO);
      })
      .onEnd((e) => {
        const commit =
          e.translationX > width * COMMIT_DISTANCE_FRACTION || e.velocityX > COMMIT_VELOCITY;
        if (commit) {
          if (kbProgress.value > KB_VISIBLE_EPS) {
            // 键盘还没收完：页面停在松手位，等键盘完全隐藏（dismiss Promise resolve）
            // 再 onClose → 宿主的 open effect 接着播挤出动画。先键盘、后页面。
            runOnJS(closeAfterKeyboard)();
          } else {
            y.value = withTiming(height, {
              duration: 500,
              easing: Easing.bezier(0.32, 0.72, 0, 1),
            });
            runOnJS(onClose)();
          }
        } else {
          y.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
        }
      });
  }, [y, height, width, onClose, activateX, failY, kbProgress]);
}

/* ── 下沉「玻璃卡」视觉（2026-07-07 用户定）──
 * chat sheet 退场不再是整屏平移，而是和 MenuDrawer 推开 tab 同一套玻璃语言：
 * 圆角 + 白雾罩（黑字变灰、彩字基本保留）+ 不缩放，全程跟手。
 * 圆角走短坡道（下沉 GLASS_RADIUS_RAMP px 内到满）——「玻璃已从屏幕剥离」的感觉
 * 一起手就成立；白雾走长坡道（半屏到满值）随退出渐浓。数值真机可再调。 */
/** 圆角满值 = MenuDrawer CARD_RADIUS 同值。 */
const GLASS_RADIUS = 40;
/** 白雾罩最大不透明度 = MenuDrawer SCRIM_MAX 同值。 */
const GLASS_SCRIM_MAX = 0.25;
/** 下沉多少 px 圆角到满。 */
const GLASS_RADIUS_RAMP = 120;

export function useGlassSinkStyles(y: SharedValue<number>, height: number) {
  const paneStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
    borderRadius: interpolate(
      y.value,
      [0, GLASS_RADIUS_RAMP],
      [0, GLASS_RADIUS],
      Extrapolation.CLAMP,
    ),
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, height * 0.5], [0, GLASS_SCRIM_MAX], Extrapolation.CLAMP),
  }));
  return { paneStyle, scrimStyle };
}
