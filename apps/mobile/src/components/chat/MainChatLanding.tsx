/**
 * Main chat 的 landing 空状态 —— web MinimalistLanding 的 RN 介质版。
 * 球 + 问候标题 + 副标题 + 3 个建议玻璃 chip（点击直接发进单例主线程，对齐
 * web handleSuggestionTap → onSubmit 立即提交）。
 *
 * 只用于 main chat 空线程：card chat 永远带 bootstrap，不会落到空状态。文案、
 * 字号、间距对齐 web（heading=display 30、subheading=bodySm 13/leading-snug、
 * chip=bodySm 13、suggestions 三条与 en/chat.json 一致）。玻璃 = expo-blur +
 * 白覆盖（同 CardContextHeaderSlot：圆角要同时给 BlurView 和覆盖层，否则毛玻璃
 * 填成方角）。chip 入场 = web 的交错 fade-up（FadeInDown 对应 initial y:8）。
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import Animated, { FadeInDown } from "react-native-reanimated";

import AiSphere from "../../ui/AiSphere";

const FG = "29,33,48";

/** en/chat.json landing.suggestions —— 与 web 一字一致（发给 LLM 的 prompt 固定英文）。 */
const SUGGESTIONS = [
  "What should I focus on today?",
  "Summarize my week so far",
  "What's on my mind lately?",
];

export default function MainChatLanding({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <AiSphere size={216} mode="idle" />
      </View>
      <Text style={styles.heading}>What&apos;s on your mind?</Text>
      <Text style={styles.subheading}>Ask anything — I have your context.</Text>

      <View style={styles.chips}>
        {SUGGESTIONS.map((label, i) => (
          <Animated.View key={label} entering={FadeInDown.delay(120 + i * 50).duration(320)}>
            <Pressable
              onPress={() => {
                if (!disabled) onSubmit(label);
              }}
              disabled={disabled}
              accessibilityRole="button"
            >
              {/* 视觉样式全在内层 View：本项目 Pressable 的 style 不渲染（NativeWind 拦截）。 */}
              <View style={[styles.chip, disabled && styles.chipDisabled]}>
                <BlurView intensity={20} tint="light" style={[StyleSheet.absoluteFill, styles.chipRound]} />
                <View style={[StyleSheet.absoluteFill, styles.chipTint, styles.chipRound]} />
                <Text style={styles.chipText} numberOfLines={2}>
                  {label}
                </Text>
                <Text style={styles.chipArrow}>→</Text>
              </View>
            </Pressable>
          </Animated.View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 顶部对齐（web landing body pt-2），不垂直居中。
  root: { alignItems: "center", paddingTop: 8 },
  hero: { marginBottom: 28 }, // web mb-7
  // web heading: variant=display(30/1.05) weight=semibold tracking-tight，foreground 实色。
  heading: {
    fontSize: 30,
    lineHeight: 32,
    letterSpacing: -0.6,
    textAlign: "center",
    color: `rgb(${FG})`,
    fontFamily: "Geist_600SemiBold",
    paddingHorizontal: 24,
  },
  // web subheading: bodySm(13) text-foreground/50 leading-snug(1.375≈18)。
  subheading: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    color: `rgba(${FG},0.5)`,
    fontFamily: "Geist_400Regular",
    paddingHorizontal: 32,
  },
  // chips 区：web 在 greeting block(pb-4) 之后，列 gap-2 px-3。
  chips: { alignSelf: "stretch", marginTop: 16, gap: 8, paddingHorizontal: 12 },
  // web chip: justify-between gap-3 px-4 py-3 rounded-2xl border-foreground/8 + 玻璃。
  chip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    overflow: "hidden",
  },
  chipDisabled: { opacity: 0.6 },
  chipRound: { borderRadius: 16 },
  chipTint: { backgroundColor: "rgba(255,255,255,0.45)" },
  chipText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: `rgba(${FG},0.75)`,
    fontFamily: "Geist_400Regular",
  },
  chipArrow: { fontSize: 15, color: `rgba(${FG},0.3)`, fontFamily: "Geist_400Regular" },
});
