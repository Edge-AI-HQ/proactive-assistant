/**
 * Goal 详情底部抽屉——web mirror.tsx `GoalDetail`（detailLayout="drawer" 强制，
 * proactive mobile shell 只走 Drawer，桌面 popup 不在本端范围）的 RN 介质版。
 *
 * 外壳对齐 web vaul Drawer：max-h 85vh、inline blur(40) saturate(1.5) + 180°
 * 白渐变(0.5→0.7) + white/40 边 + 顶圆角 1.5rem(24)、遮罩 foreground/5 +
 * blur(2px)、默认把手（ui/drawer.tsx：100×8 bg-muted + 底光晕）、下拉 dismiss。
 * RN 壳复用 CardDetailSheet 既定模式：in-tree 绝对定位 + expo-blur +
 * LinearGradient + Reanimated spring + Pan 下拉（web goal drawer 无横滑下沉，
 * 不加 sink 手势）。
 *
 * 正文逐字对齐 web `GoalDetailBody`：header（32 配图 + basket label + status
 * pill + pct）→ 进度条（width 0→pct 600ms easeOut）→ summary → 分隔线 →
 * AI Weekly Actions（绿 check）→ Monitoring（amber pulse 点）→ AI wants to
 * know（mic 按钮行，web 无 onClick，纯展示）→ Lock Goals（同样纯展示）。
 * weeklyActions/monitoring/aiQuestions 是 en/profile.json goalMeta 的 demo
 * 列表（web 亦然，非后端数据）。
 */
import { useEffect, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { ArrowRightCircle, Check, Mic } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Goal } from "@pin-ai/core";

import {
  basketMeta,
  getVisualMeta,
  goalMetaLists,
  priorityToStatus,
  statusLabel,
  type VisualStatus,
} from "./mirror-helpers";

const FG = "29,33,48"; // --foreground ≈ rgb(29,33,48)
const TOP_RADIUS = 24; // web borderRadius 1.5rem

// tailwind palette（web statusBarColor / 详情 pill / 详情 pct 文本）
const EMERALD_500 = "#10b981";
const ROSE_400 = "#fb7185";
const AMBER_500 = "#f59e0b";
const AMBER_400 = "#fbbf24";

/** web statusBarColor：bg-{emerald,rose,amber}-400/50。 */
const STATUS_BAR_COLOR: Record<VisualStatus, string> = {
  Normal: "rgba(52,211,153,0.5)",
  Alert: "rgba(251,113,133,0.5)",
  Watch: "rgba(251,191,36,0.5)",
};

/** web 详情 status pill：bg-{rose,amber,emerald}-50 + text-{rose-400,amber-500,emerald-500}。 */
const STATUS_PILL: Record<VisualStatus, { bg: string; text: string }> = {
  Normal: { bg: "#ecfdf5", text: EMERALD_500 },
  Alert: { bg: "#fff1f2", text: ROSE_400 },
  Watch: { bg: "#fffbeb", text: AMBER_500 },
};

/** web 详情 pct 数字色：text-{emerald-500,rose-400,amber-500}。 */
const STATUS_PCT_TEXT: Record<VisualStatus, string> = {
  Normal: EMERALD_500,
  Alert: ROSE_400,
  Watch: AMBER_500,
};

/** 进度条内条——web motion.div width 0 → pct%（0.6s easeOut），mount 时播一次。 */
function AnimatedBar({ pct, color }: { pct: number; color: string }) {
  const w = useSharedValue(0);
  useEffect(() => {
    w.value = withTiming(pct, { duration: 600, easing: Easing.out(Easing.ease) });
  }, [pct, w]);
  const st = useAnimatedStyle(() => ({ width: `${w.value}%` }));
  return <Animated.View style={[styles.progressFill, { backgroundColor: color }, st]} />;
}

/** Monitoring 圆点——web animate-pulse（opacity 1→.5→1，2s，cubic-bezier(.4,0,.6,1)）。 */
function PulseDot() {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(
      withTiming(0.5, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
      -1,
      true,
    );
  }, [o]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[styles.monitorDot, st]} />;
}

export default function GoalDetailSheet({
  goal,
  onClose,
}: {
  /** null = 关闭（web `goal=null` 即关闭）。退场期间壳滑下、正文跟 goal 走（对齐 vaul）。 */
  goal: Goal | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("profile");
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const open = goal !== null;
  // mounted 模式照 CardDetailSheet：退场动画播完再卸载（不占触摸层）。
  const [mounted, setMounted] = useState(open);
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
  const dimStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, y.value / height) }));

  const visual = goal ? getVisualMeta(goal.key) : null;
  const basket = goal ? basketMeta(goal.key) : null;
  const status: VisualStatus = goal ? priorityToStatus(goal.priority) : "Normal";
  const lists = visual ? goalMetaLists(visual.metaKey) : null;
  const pill = STATUS_PILL[status];

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* 遮罩：web overlay !bg-foreground/5 backdrop-blur-[2px]，点击关闭 */}
      <Animated.View style={[StyleSheet.absoluteFill, { bottom: -insets.bottom }, dimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <BlurView intensity={10} tint="light" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.dimTint]} />
        </Pressable>
      </Animated.View>

      <Animated.View
        style={[styles.panelWrap, { maxHeight: height * 0.85, bottom: -insets.bottom }, panelStyle]}
      >
        <GestureDetector gesture={dragDown}>
          <View style={styles.panel}>
            {/* web inline backdropFilter blur(40px) saturate(1.5)（inline style 不被
                native-power-save 砍，dev 真机有 blur）→ BlurView 65（CardDetailSheet 同映射） */}
            <BlurView intensity={65} tint="light" style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={["rgba(255,255,255,0.5)", "rgba(255,255,255,0.7)"]}
              style={StyleSheet.absoluteFill}
            />
            {/* 把手：ui/drawer.tsx 默认 h-2 w-[100px] rounded-full bg-muted + 底光晕 */}
            <View style={styles.handleWrap}>
              <View style={styles.handle} />
            </View>
            {goal && visual && basket && lists ? (
              <ScrollView
                style={{ maxHeight: height * 0.75 }}
                contentContainerStyle={[styles.scrollContent, { paddingBottom: 24 + insets.bottom }]}
              >
                {/* header 行：配图 32 + basket label + status pill ｜ pct */}
                <View style={styles.headerRow}>
                  <View style={styles.headerLeft}>
                    <Image source={visual.image} style={styles.headerImage} resizeMode="contain" />
                    <Text style={styles.headerLabel}>{basket.label}</Text>
                    <View style={[styles.statusPill, { backgroundColor: pill.bg }]}>
                      <Text style={[styles.statusPillText, { color: pill.text }]}>
                        {statusLabel(status)}
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.headerPct, { color: STATUS_PCT_TEXT[status] }]}>
                    {visual.pct}%
                  </Text>
                </View>

                {/* 进度条 h-2 bg-foreground/5 */}
                <View style={styles.progressTrack}>
                  <AnimatedBar pct={visual.pct} color={STATUS_BAR_COLOR[status]} />
                </View>

                <Text style={styles.summary}>{goal.summary || goal.title}</Text>

                <View style={styles.divider} />

                {/* AI Weekly Actions（web h3 的 uppercase class → RN 串上 toUpperCase，
                    WorkbenchTabButton 同款适配；下两个分区标题同理） */}
                <Text style={[styles.sectionHeading, { color: EMERALD_500 }]}>
                  {t("goalsView.goals.weeklyActions").toUpperCase()}
                </Text>
                <View style={styles.listBlock}>
                  {lists.weeklyActions.map((action, i) => (
                    <View key={i} style={styles.listRow}>
                      <Check size={14} color={EMERALD_500} style={styles.checkIcon} />
                      <Text style={styles.actionText}>{action}</Text>
                    </View>
                  ))}
                </View>

                {/* Monitoring */}
                <Text style={[styles.sectionHeading, { color: AMBER_500 }]}>
                  {t("goalsView.goals.monitoring").toUpperCase()}
                </Text>
                <View style={styles.listBlock}>
                  {lists.monitoring.map((item, i) => (
                    <View key={i} style={styles.listRow}>
                      <PulseDot />
                      <Text style={styles.monitorText}>{item}</Text>
                    </View>
                  ))}
                </View>

                {/* AI wants to know（web <button> 无 onClick，纯展示 + 按压反馈） */}
                <Text style={[styles.sectionHeading, { color: `rgba(${FG},0.5)` }]}>
                  {t("goalsView.goals.aiWantsToKnow").toUpperCase()}
                </Text>
                <View style={styles.listBlock}>
                  {lists.aiQuestions.map((q, i) => (
                    <Pressable key={i} accessibilityRole="button">
                      {({ pressed }) => (
                        <View
                          style={[
                            styles.questionRow,
                            pressed && { backgroundColor: `rgba(${FG},0.1)` },
                          ]}
                        >
                          <View style={styles.micCircle}>
                            <Mic size={14} color="#f2f4f8" />
                          </View>
                          <Text style={styles.questionText}>{q}</Text>
                          <ArrowRightCircle size={14} color="#1d2130" />
                        </View>
                      )}
                    </Pressable>
                  ))}
                </View>

                {/* Lock Goals（web 同样无 onClick） */}
                <Pressable accessibilityRole="button">
                  <View style={styles.lockButton}>
                    <Text style={styles.lockButtonText}>{t("goalsView.goals.lockGoals")}</Text>
                  </View>
                </Pressable>
              </ScrollView>
            ) : null}
          </View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  dimTint: { backgroundColor: `rgba(${FG},0.05)` },
  panelWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  panel: {
    overflow: "hidden",
    borderTopLeftRadius: TOP_RADIUS,
    borderTopRightRadius: TOP_RADIUS,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(255,255,255,0.4)",
  },
  // 把手区：mt-4 + pb-4；光晕 0 14px 24px 12px hsla(--background/0.6)
  handleWrap: {
    alignSelf: "center",
    marginTop: 16,
    paddingBottom: 16,
    boxShadow: "0 14px 24px 12px rgba(242,244,248,0.6)",
  },
  handle: { width: 100, height: 8, borderRadius: 999, backgroundColor: "rgb(226,228,233)" },
  // web 正文容器 px-5 pb-6 pt-2
  scrollContent: { paddingHorizontal: 20, paddingTop: 8 },

  // header 行（mb-3）
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerImage: { width: 32, height: 32 },
  // web text-display text-lg(18)/600（.text-display 紧排 -0.02em → 18*-0.02）
  headerLabel: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.36,
    color: "#1d2130",
  },
  statusPill: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontFamily: "Inter_500Medium", lineHeight: 15 },
  headerPct: { fontSize: 18, fontFamily: "Inter_600SemiBold", letterSpacing: -0.36 },

  // 进度条（h-2 mb-4 bg-foreground/5）
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: `rgba(${FG},0.05)`,
    marginBottom: 16,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 999 },

  // summary text-sm(14) foreground/80 mb-4
  summary: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20, color: `rgba(${FG},0.8)`, marginBottom: 16 },
  divider: { height: 1, backgroundColor: `rgba(${FG},0.1)`, marginBottom: 16 },

  // 分区标题 text-xs(12)/600 uppercase tracking-wider(0.05em→0.6) mb-3
  sectionHeading: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    marginBottom: 12,
  },
  // 列表块 space-y-2.5 mb-5
  listBlock: { gap: 10, marginBottom: 20 },
  listRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  checkIcon: { marginTop: 2 },
  // text-sm leading-snug(14*1.375≈19)
  actionText: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 19, color: `rgba(${FG},0.8)` },
  monitorDot: { width: 10, height: 10, borderRadius: 999, backgroundColor: AMBER_400, marginTop: 4 },
  monitorText: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 19, color: `rgba(${FG},0.75)` },

  // AI question 行：p-3.5(14) rounded-2xl(16) border foreground/10 bg-foreground/3
  questionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.1)`,
    backgroundColor: `rgba(${FG},0.03)`,
  },
  micCircle: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: "#1d2130",
    alignItems: "center",
    justifyContent: "center",
  },
  questionText: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 19, color: `rgba(${FG},0.8)` },

  // Lock：py-3.5 rounded-2xl bg-foreground/4 text-sm/500 foreground/50
  lockButton: {
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: `rgba(${FG},0.04)`,
    alignItems: "center",
  },
  lockButtonText: { fontSize: 14, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.5)` },
});
