/**
 * 设置子页左缘滑动返回 —— web `proactive-ai-frontend/components/app/SwipeBackLayer.tsx`
 * （framer drag）的 RN 对应物。dev 行为：左缘窄条捕获 pointerdown（≤20px 起拖，
 * 命中带 24px 宽、DOM 最后 + 最高 z 防全屏子元素吞事件）→ 内容跟手横移 →
 * 松手 offset > 32% 屏宽 或 速度 > 400px/s 提交（200ms bezier(.32,.72,0,1) 滑出后
 * onBack），否则 spring(500/40) 回弹。
 * RN 等价：绝对定位左缘条上挂 RNGH Pan（activeOffsetX 10 认右滑起拖、
 * failOffsetY ±12 竖滑交还内层 ScrollView，数值同 chat 的 useSinkDismissGesture
 * 手感）+ reanimated translateX。
 */
import { useMemo, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

/** dev 左缘命中带宽度（w-6 = 24px）。 */
const EDGE_WIDTH = 24;
/** Fraction of viewport width (or velocity) the drag must reach for release
 *  to commit the back navigation. Tuned on-device (同 dev)。 */
const COMMIT_DISTANCE_FRACTION = 0.32;
const COMMIT_VELOCITY_PX_S = 400;

export default function SwipeBackLayer({
  onBack,
  children,
}: {
  /** Called after the layer has slid fully off-screen (commit) — typically
   *  unmounts this layer, revealing whatever is underneath. */
  onBack: () => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(10)
        .failOffsetY([-12, 12])
        .onUpdate((e) => {
          x.value = Math.max(0, e.translationX);
        })
        .onEnd((e) => {
          const commit =
            e.translationX > width * COMMIT_DISTANCE_FRACTION ||
            e.velocityX > COMMIT_VELOCITY_PX_S;
          if (commit) {
            // Slide the rest of the way out, continuous with the drag, then pop.
            x.value = withTiming(
              width,
              { duration: 200, easing: Easing.bezier(0.32, 0.72, 0, 1) },
              (finished) => {
                if (finished) runOnJS(onBack)();
              },
            );
          } else {
            // Didn't cross the threshold — spring back to rest.
            x.value = withSpring(0, { stiffness: 500, damping: 40 });
          }
        }),
    [onBack, width, x],
  );

  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    // 注意不加 overflow:"hidden"（dev 有）：RN 子页 ScrollView 靠负 margin 出血到
    // 物理屏幕边（刘海/home-indicator 下），clip 会截掉出血；滑动时内容右移出屏
    // 本就落在设备边界外，无需裁剪。
    <View style={{ flex: 1 }}>
      <Animated.View style={[{ flex: 1 }, contentStyle]}>{children}</Animated.View>
      {/* Edge hit-zone: 树里最后 + 盖在内容上，只有最左 24px 可交互（同 dev）。 */}
      <GestureDetector gesture={pan}>
        <View
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: EDGE_WIDTH }}
          accessibilityElementsHidden
        />
      </GestureDetector>
    </View>
  );
}
