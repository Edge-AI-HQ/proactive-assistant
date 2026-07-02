/**
 * keep-alive 页面壳 + 页面可见性上下文。
 * - 每页首访挂载后常驻（display:none 隐藏，不卸载）：切回零重载、滚动/状态原位，
 *   TQ 缓存持续新鲜 → 切页不再出 loading（对齐主流 App tab 常驻范式）。
 * - 激活/退场各 180ms 淡入淡出（页面 absoluteFill 堆叠 → cross-fade，替代旧
 *   PageFade 的卸载式转场）。
 * - PageActiveContext：常驻页里的无限动画循环（Tasks 徽章 Spin/Pulse、Ambient
 *   PingRing 等）据此在页面不可见时停帧——否则 keep-alive 会让 UI 线程空跑发热。
 *   默认 true：页面栈以外的使用处（chat sheet 等）行为不变。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const PageActiveContext = createContext(true);

/** 所在 keep-alive 页当前是否可见（不在页面栈内的组件恒 true）。 */
export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

const FADE_MS = 180;

export function KeepAlivePage({ active, children }: { active: boolean; children: ReactNode }) {
  const opacity = useSharedValue(0);
  // 退场淡出播完才 display:none（保 cross-fade；仍不卸载）。
  const [shown, setShown] = useState(active);

  useEffect(() => {
    if (active) {
      setShown(true);
      opacity.value = withTiming(1, { duration: FADE_MS });
    } else {
      opacity.value = withTiming(0, { duration: FADE_MS }, (finished) => {
        if (finished) runOnJS(setShown)(false);
      });
    }
  }, [active, opacity]);

  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, fade, shown ? null : styles.hidden]}
      pointerEvents={active ? "auto" : "none"}
    >
      <PageActiveContext.Provider value={active}>{children}</PageActiveContext.Provider>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
});
