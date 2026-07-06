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
 */
import { useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  Easing,
  runOnJS,
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
  return useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(activateX)
        .failOffsetY([-failY, failY])
        .onUpdate((e) => {
          // 右移 → 下沉，跟手（clamp 0：往回拖不把面板顶过屏顶）。
          y.value = Math.max(0, e.translationX * SINK_RATIO);
        })
        .onEnd((e) => {
          const commit =
            e.translationX > width * COMMIT_DISTANCE_FRACTION || e.velocityX > COMMIT_VELOCITY;
          if (commit) {
            y.value = withTiming(height, {
              duration: 500,
              easing: Easing.bezier(0.32, 0.72, 0, 1),
            });
            runOnJS(onClose)();
          } else {
            y.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
          }
        }),
    [y, height, width, onClose, activateX, failY],
  );
}
