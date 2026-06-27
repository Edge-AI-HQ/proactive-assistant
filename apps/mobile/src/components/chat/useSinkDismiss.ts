/**
 * 聊天 sheet 的「右滑下沉退出」手势 —— main chat 与 card chat 统一用这一份，保证
 * 两个聊天进出体感完全一致（对齐 web ChatSheetOverlay：rightward drag → downward
 * sink，露出底下的实时页面）。
 *
 * 与早期「左缘 20px 条」做法的区别（本次按行业标准重做）：
 *  - **任意处可滑**：手势包裹整张 sheet，不再限定左缘窄条（main chat 之前不响应就
 *    是因为只有那条窄条触发）。
 *  - **和竖直滚动共存**：`activeOffsetX(20)` 只在右滑 ≥20px 时激活；`failOffsetY`
 *    在竖直先动 ≥12px 时让手势失败，把竖直交还给聊天列表 / landing 滚动。
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
/** 右滑 ≥20px 激活手势；竖直先动 ≥12px 则让位给列表滚动。 */
const ACTIVATE_X = 20;
const FAIL_Y = 12;

export function useSinkDismissGesture(
  y: SharedValue<number>,
  height: number,
  width: number,
  onClose: () => void,
) {
  return useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(ACTIVATE_X)
        .failOffsetY([-FAIL_Y, FAIL_Y])
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
    [y, height, width, onClose],
  );
}
