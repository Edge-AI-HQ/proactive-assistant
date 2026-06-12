/**
 * 卡片详情底部抽屉——web CardDrawer（vaul）的 RN 介质版（球面卡 tap 后）。
 * web 真源：max-h 92vh、玻璃 = 180° 白渐变(0.5→0.7) + blur(40px)
 * saturate(1.5) + white/40 边 + 顶圆角 1.5rem；遮罩 foreground/5 +
 * blur(2px)；下拉手势 dismiss。
 * RN 介质：in-tree 绝对定位（系统 Modal 是独立 window，BlurView 采样
 * 不到底下内容）+ expo-blur + LinearGradient + Reanimated spring
 * （overshootClamping，同抽屉/chat sheet 的无弹跳约定）+ Pan 下拉关闭。
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { VisibleCardEntry } from "@pin-ai/core";

const TOP_RADIUS = 24;

export default function CardDetailSheet({
  entry,
  onClose,
  onConfirm,
  onSteer,
  onSnooze,
  onDismiss,
}: {
  entry: VisibleCardEntry | null;
  onClose: () => void;
  onConfirm: (e: VisibleCardEntry) => void;
  onSteer: (e: VisibleCardEntry) => void;
  onSnooze: (e: VisibleCardEntry) => void;
  onDismiss: (e: VisibleCardEntry) => void;
}) {
  const { height } = useWindowDimensions();
  const open = entry !== null;
  // 退场动画播完再卸载（同 MenuDrawer 的 mounted 模式）。
  const [mounted, setMounted] = useState(open);
  // 面板纵向偏移：0 = 全开，height = 收起在屏外。
  const y = useSharedValue(height);

  useEffect(() => {
    if (open) {
      setMounted(true);
      y.value = withSpring(0, { stiffness: 320, damping: 32, mass: 0.9, overshootClamping: true });
    } else {
      y.value = withTiming(height, { duration: 320, easing: Easing.out(Easing.cubic) }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
  }, [open, height, y]);

  // 下拉 dismiss（web vaul 同款手感）：跟手，松手超 1/4 高或 vy>600 关闭。
  const dragDown = Gesture.Pan()
    .activeOffsetY(12)
    .onUpdate((e) => {
      y.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > height * 0.18 || e.velocityY > 600) {
        runOnJS(onClose)();
      } else {
        y.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
      }
    });

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const dimStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, y.value / height),
  }));

  if (!mounted) return null;
  const card = entry?.card;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* 遮罩：web foreground/5 + blur(2px)。 */}
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <BlurView intensity={10} tint="light" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.dimTint]} />
        </Pressable>
      </Animated.View>

      <Animated.View style={[styles.panelWrap, { maxHeight: height * 0.92 }, panelStyle]}>
        <GestureDetector gesture={dragDown}>
          <View style={styles.panel}>
            {/* web 玻璃面：blur(40) + 180° 白渐变(0.5→0.7) + white/40 边。 */}
            <BlurView intensity={65} tint="light" style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={["rgba(255,255,255,0.5)", "rgba(255,255,255,0.7)"]}
              style={StyleSheet.absoluteFill}
            />
            {/* vaul 把手。 */}
            <View style={styles.handle} />
            {card && entry ? (
              <>
                <ScrollView className="px-6 pt-4" contentContainerClassName="pb-4">
                  <Text
                    className="text-[11px] tracking-[1.5px] text-muted-foreground"
                    style={{ fontFamily: "Inter_600SemiBold" }}
                  >
                    {card.goalBasket.toUpperCase()}
                  </Text>
                  <Text
                    className="mt-2 text-[22px] leading-7 text-foreground"
                    style={{ fontFamily: "Inter_700Bold" }}
                  >
                    {card.title}
                  </Text>
                  {card.whyNow ? (
                    <Text
                      className="mt-3 text-[13px] leading-5 text-amber-700"
                      style={{ fontFamily: "Inter_500Medium" }}
                    >
                      {card.whyNow}
                    </Text>
                  ) : null}
                  {card.summary ? (
                    <Text
                      className="mt-3 text-[15px] leading-6 text-foreground/80"
                      style={{ fontFamily: "Inter_400Regular" }}
                    >
                      {card.summary}
                    </Text>
                  ) : null}
                </ScrollView>
                <View className="px-6 pb-10 gap-2">
                  <Pressable
                    onPress={() => onConfirm(entry)}
                    accessibilityRole="button"
                    accessibilityLabel={card.primaryAction?.label || "Confirm"}
                    className="items-center rounded-2xl bg-foreground py-3.5"
                  >
                    <Text className="text-[15px] text-white" style={{ fontFamily: "Inter_600SemiBold" }}>
                      {card.primaryAction?.label || "Confirm"}
                    </Text>
                  </Pressable>
                  <View className="flex-row gap-2">
                    {[
                      { label: "Steer", fn: onSteer },
                      { label: "Snooze", fn: onSnooze },
                      { label: "Dismiss", fn: onDismiss },
                    ].map(({ label, fn }) => (
                      <Pressable
                        key={label}
                        onPress={() => fn(entry)}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        className="flex-1 items-center rounded-2xl bg-white/80 border border-white/70 py-3"
                      >
                        <Text className="text-[14px] text-foreground/75" style={{ fontFamily: "Inter_500Medium" }}>
                          {label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </>
            ) : null}
          </View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  dimTint: { backgroundColor: "rgba(29, 33, 48, 0.05)" },
  panelWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  panel: {
    overflow: "hidden",
    borderTopLeftRadius: TOP_RADIUS,
    borderTopRightRadius: TOP_RADIUS,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(255,255,255,0.4)",
  },
  handle: {
    alignSelf: "center",
    marginTop: 8,
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(29,33,48,0.15)",
  },
});
