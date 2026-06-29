/**
 * 卡片详情底部抽屉——web CardDrawerContent + DrawerDetailBody 的 RN 介质版。
 * 外壳（玻璃/遮罩/把手/下拉关闭）：web CardDrawer（vaul）——max-h 92vh、
 * blur(40) + 180° 白渐变(0.5→0.7) + white/40 边 + 顶圆角 1.5rem；遮罩
 * foreground/5 + blur(2px)；下拉 dismiss。RN：in-tree 绝对定位 + expo-blur +
 * LinearGradient + Reanimated spring（overshootClamping）+ Pan 下拉关闭。
 *
 * 内容逐字对齐 web：类目图标 + Urgent(urgency≥0.85) + 标题 + 简略行(willExecute)
 * + WHY NOW(绿框) + SOURCES(chips) + HOW I REASONED(可折叠) + 三按钮
 * Dismiss/Done/Approve（reminder → Chat）。EXECUTION PLAN（实时 run，
 * useCardExecutionRun）是后续刀，本刀先不接。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutAnimation,
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
import MaskedView from "@react-native-masked-view/masked-view";
import { Brain, Check, ChevronDown, Loader2, MessageCircle, X, Zap } from "lucide-react-native";
import {
  basketToLovableCategory,
  isReminderCard,
  reasoningStepLabel,
  type ReasoningStep,
  type SSEEvent,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardExecutionRun } from "@pin-ai/state";

import { useSinkDismissGesture } from "../chat/useSinkDismiss";
import { CATEGORIES } from "./SphereCards";
import { sourceIcon, sourceLabel } from "../../lib/source-icons";
import { toolIcon } from "../../lib/tool-icons";
import { readLocalHistory } from "../../lib/sync/sync-bootstrap";

/** 主色 --primary: hsl(292 78% 63%) ≈ rgb(215,87,234)。 */
const PRIMARY = "215,87,234";
/** 渐变末端 hsl(330 80% 65%) ≈ rgb(237,94,166)（web EXECUTION PLAN 文字 from-primary → to-pink）。 */
const PINK = "237,94,166";

const TOP_RADIUS = 24;
/** web realIntentToChatCard：urgency ≥ 0.85 → "Urgent" 徽章。 */
const URGENT_THRESHOLD = 0.85;

/** web eventsToFallbackPlan：plan 空时从 tool-call 事件压出 plan（去重、跳 propose_action）。 */
function eventsToFallbackPlan(events: SSEEvent[]): { text: string; tool: string }[] {
  const seen = new Set<string>();
  const rows: { text: string; tool: string }[] = [];
  for (const ev of events) {
    if (ev.type !== "chat:tool:start") continue;
    const name = typeof ev.data?.name === "string" ? ev.data.name : "";
    if (!name || name === "propose_action" || seen.has(name)) continue;
    seen.add(name);
    const preview = typeof ev.data?.argsPreview === "string" ? ev.data.argsPreview.trim() : "";
    rows.push({ text: preview && preview.length <= 140 ? preview : `Called ${name}`, tool: name });
  }
  return rows;
}

/** 旋转（web Loader2 animate-spin 的 RN 对应物）。 */
function Spin({ children }: { children: ReactNode }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
  }, [r]);
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return <Animated.View style={st}>{children}</Animated.View>;
}

/** 渐变文字——web EXECUTION PLAN 标签 bg-clip-text(primary→pink)，RN 用 MaskedView。 */
function GradientLabel({ text }: { text: string }) {
  return (
    <MaskedView maskElement={<Text style={styles.planLabel}>{text}</Text>}>
      <LinearGradient colors={[`rgb(${PRIMARY})`, `rgb(${PINK})`]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        <Text style={[styles.planLabel, styles.invisible]}>{text}</Text>
      </LinearGradient>
    </MaskedView>
  );
}

/** SOURCES chip——web SourcePill：圆角 + 白底图标盒 + label。 */
function SourcePill({ slug }: { slug: string }) {
  const Icon = sourceIcon(slug);
  return (
    <View style={styles.pill}>
      <View style={styles.pillIcon}>
        <Icon size={12} color="rgba(29,33,48,0.7)" strokeWidth={1.8} />
      </View>
      <Text style={styles.pillLabel}>{sourceLabel(slug)}</Text>
    </View>
  );
}

/** HOW I REASONED——web HowGeneratedSection：默认折叠，点开展开 reasoning steps。 */
function HowReasoned({ steps }: { steps: ReasoningStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setOpen((v) => !v);
  };
  return (
    <View style={styles.howBox}>
      <Pressable onPress={toggle} style={styles.collapHeader} accessibilityRole="button">
        <View style={styles.rowCenter}>
          <Brain size={13} color="rgba(29,33,48,0.55)" strokeWidth={2.2} />
          <Text style={styles.sectionLabelMuted}>HOW I REASONED</Text>
          <Text style={styles.stepCount}>· {steps.length} {steps.length === 1 ? "step" : "steps"}</Text>
        </View>
        <ChevronDown
          size={16}
          color="rgba(29,33,48,0.4)"
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {open ? (
        <View style={styles.howBody}>
          {steps.map((s, i) => (
            <View key={i} style={styles.stepRow}>
              <Text style={styles.stepNum}>{i + 1}</Text>
              <View style={styles.flex1}>
                <Text style={styles.stepLabel}>{reasoningStepLabel(s.label).toUpperCase()}</Text>
                <Text style={styles.stepDetail}>{s.detail}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** EXECUTION PLAN 单步行——web ExecutionStepRow：工具图标盒 + 文本 + 工具名。 */
function ExecutionStepRow({ step }: { step: { text: string; tool: string } }) {
  const Icon = toolIcon(`${step.text} ${step.tool}`);
  return (
    <View style={styles.execRow}>
      <View style={styles.execIconBox}>
        <Icon size={13} color={`rgba(${FG},0.75)`} strokeWidth={1.8} />
      </View>
      <View style={styles.execText}>
        <Text style={styles.execStepText}>{step.text}</Text>
        <Text style={styles.execStepTool}>{step.tool.toUpperCase()}</Text>
      </View>
    </View>
  );
}

/** EXECUTION PLAN——web DrawerDetailBody 粉色可折叠区（默认展开 + 时间轴轨）。
 *  来自实时 run 的 lastMessagePayload.plan。 */
function ExecutionPlan({ steps, preparing }: { steps: { text: string; tool: string }[]; preparing: boolean }) {
  const [open, setOpen] = useState(true);
  if (steps.length === 0 && !preparing) return null;
  // 有 run 但 plan 还没到（agent 准备中）：web statusBanner.preparing。
  if (steps.length === 0) {
    return (
      <View style={styles.planPreparing}>
        <Spin>
          <Loader2 size={13} color={`rgba(${FG},0.55)`} />
        </Spin>
        <Text style={styles.preparingText}>Agent is preparing the plan — give it a moment.</Text>
      </View>
    );
  }
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setOpen((v) => !v);
  };
  return (
    <View style={styles.planBox}>
      <LinearGradient
        colors={[`rgba(${PRIMARY},0.1)`, `rgba(${PRIMARY},0.04)`]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Pressable onPress={toggle} style={styles.collapHeader} accessibilityRole="button">
        <View style={styles.rowCenter}>
          <Zap size={13} color={`rgb(${PRIMARY})`} strokeWidth={2.5} />
          <GradientLabel text="EXECUTION PLAN" />
          <Text style={styles.stepCount}>· {steps.length} {steps.length === 1 ? "step" : "steps"}</Text>
        </View>
        <ChevronDown
          size={16}
          color={`rgba(${PRIMARY},0.7)`}
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {open ? (
        <View style={styles.planBody}>
          <View style={styles.planRail} />
          {steps.map((s, i) => (
            <ExecutionStepRow key={i} step={s} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function CardDetailSheet({
  entry,
  onClose,
  onDismiss,
  onComplete,
  onApprove,
  onChat,
}: {
  entry: VisibleCardEntry | null;
  onClose: () => void;
  /** web onDismiss：丢弃 + 退场。 */
  onDismiss: (e: VisibleCardEntry) => void;
  /** web onComplete（Done）：办好了/知道了 + 退场（POST complete）。 */
  onComplete: (e: VisibleCardEntry) => void;
  /** web onExecute（Approve）：开 card chat 交 agent 执行（confirmBootstrap）。 */
  onApprove: (e: VisibleCardEntry) => void;
  /** web onChat（reminder 卡的主操作）：纯开会话，不带 execute bootstrap。 */
  onChat: (e: VisibleCardEntry) => void;
}) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const open = entry !== null;
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

  // 横滑下沉手势（= chat sheets 的 useSinkDismiss = web ChatSheetOverlay：右滑 → 下沉退出，
  // failOffsetY 让位竖直滚动）。与下拉 Race 组合后包住整个面板：下拉 或 右滑都把 drawer 挤下屏幕。
  const sinkGesture = useSinkDismissGesture(y, height, width, onClose);
  const panelGesture = Gesture.Race(dragDown, sinkGesture);

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, y.value / height) }));
  // Part B：card 执行 run（web useCardExecutionRun）——拿 lastMessagePayload.plan
  // 渲染 EXECUTION PLAN。runId=null（抽屉关）时 hook no-op；本地历史源同主 chat。
  const run = useCardExecutionRun(entry?.card?.id ?? null, { localHistory: readLocalHistory });

  if (!mounted) return null;
  const card = entry?.card;
  if (!card || !entry) return null;

  const cat = CATEGORIES[basketToLovableCategory(card.goalBasket)] ?? CATEGORIES.life;
  const CatIcon = cat.icon;
  const reminder = isReminderCard(card);
  const isUrgent = (card.urgency ?? 0) >= URGENT_THRESHOLD;
  // 简略「要做什么」行（web：reminder → 提醒文，否则 willExecute(primaryAction.label)）。
  const brief = reminder ? card.summary : card.primaryAction?.label || card.summary;
  // WHY NOW：web realIntentToChatCard 仅在 whyNow 非空且 ≠ summary 时给。
  const showWhyNow = !!(card.whyNow && card.whyNow.trim() && card.whyNow !== card.summary);
  const sources = card.sourceApps ?? [];
  const steps = card.reasoningSteps ?? [];
  // web backendPlanToLovable：plan step → { text: summary, tool: slug || tool }；
  // plan 空时回落 tool-call 事件（web eventsToFallbackPlan）。
  const cachedPlan = (run.lastMessagePayload?.plan ?? []).map((s) => ({
    text: s.summary,
    tool: s.slug || s.tool,
  }));
  const planSteps = cachedPlan.length > 0 ? cachedPlan : eventsToFallbackPlan(run.events);
  // agent 在跑但 plan 还没到 → 显示「准备中」（web statusBanner running/resuming）。
  const planPreparing =
    planSteps.length === 0 &&
    (run.snapshot?.status === "running" || run.snapshot?.status === "resuming");

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { bottom: -insets.bottom }, dimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <BlurView intensity={10} tint="light" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.dimTint]} />
        </Pressable>
      </Animated.View>

      <Animated.View style={[styles.panelWrap, { maxHeight: height * 0.92, bottom: -insets.bottom }, panelStyle]}>
        {/* 手势包住整个面板（用户要求）：Race(下拉, 横滑) —— 下拉 或 右滑都把面板下沉退出（对齐 web
            vaul 下拉 + ChatSheetOverlay 横滑下沉）。横滑 failOffsetY 让位竖直滚动、不抢按钮 tap。 */}
        <GestureDetector gesture={panelGesture}>
        <View style={styles.panel}>
          <BlurView intensity={65} tint="light" style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={["rgba(255,255,255,0.5)", "rgba(255,255,255,0.7)"]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.handle} />
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom }]}
          >
            {/* 类目行：图标 + 类目名 + Urgent */}
            <View style={styles.catRow}>
              <CatIcon size={14} color="rgba(29,33,48,0.5)" strokeWidth={1.5} />
              <Text style={styles.catLabel}>{cat.label.toUpperCase()}</Text>
              {isUrgent ? (
                <View style={styles.urgentPill}>
                  <Text style={styles.urgentText}>Urgent</Text>
                </View>
              ) : null}
            </View>

            {/* 标题（web text-display text-subheading 17/600/-0.02em） */}
            <Text style={styles.title}>{card.title}</Text>

            {/* 简略行 */}
            {brief ? <Text style={styles.brief}>{brief}</Text> : null}

            {/* WHY NOW（绿框） */}
            {showWhyNow ? (
              <View style={styles.whyNowBox}>
                <Text style={styles.whyNowLabel}>WHY NOW</Text>
                <Text style={styles.whyNowBody}>{card.whyNow}</Text>
              </View>
            ) : null}

            {/* EXECUTION PLAN（实时 run plan + events 兜底 + 准备中态） */}
            <ExecutionPlan steps={planSteps} preparing={planPreparing} />

            {/* SOURCES */}
            {sources.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>SOURCES</Text>
                <View style={styles.sourceWrap}>
                  {sources.map((s) => (
                    <SourcePill key={s} slug={s} />
                  ))}
                </View>
              </View>
            ) : null}

            {/* HOW I REASONED（可折叠） */}
            <HowReasoned steps={steps} />

            {/* 动作行：Dismiss / Done / Approve（reminder → Chat） */}
            <View style={styles.actions}>
              <Pressable
                onPress={() => onDismiss(entry)}
                style={styles.btnSecondary}
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
              >
                <X size={13} color="rgba(29,33,48,0.55)" strokeWidth={2} />
                <Text style={styles.btnSecondaryText}>Dismiss</Text>
              </Pressable>
              <Pressable
                onPress={() => onComplete(entry)}
                style={styles.btnDone}
                accessibilityRole="button"
                accessibilityLabel="Done"
              >
                <Check size={12} color="rgba(29,33,48,0.55)" strokeWidth={2.5} />
                <Text style={styles.btnDoneText}>Done</Text>
              </Pressable>
              <Pressable
                onPress={() => (reminder ? onChat(entry) : onApprove(entry))}
                style={styles.btnPrimary}
                accessibilityRole="button"
                accessibilityLabel={reminder ? "Chat" : "Approve"}
              >
                {reminder ? (
                  <MessageCircle size={13} color="#fff" strokeWidth={2} />
                ) : (
                  <Check size={13} color="#fff" strokeWidth={2.5} />
                )}
                <Text style={styles.btnPrimaryText}>{reminder ? "Chat" : "Approve"}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}

const FG = "29,33,48"; // --foreground ≈ rgb(29,33,48)

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
  handle: {
    alignSelf: "center",
    marginTop: 8,
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: `rgba(${FG},0.15)`,
  },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 36 },

  // 类目行
  catRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" },
  catLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3, color: `rgba(${FG},0.5)` },
  urgentPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: `rgba(${FG},0.1)` },
  urgentText: { fontSize: 11, fontFamily: "Inter_700Bold", color: `rgba(${FG},0.5)` },

  // 标题 + 简略行
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold", letterSpacing: -0.34, lineHeight: 23, color: "#1d2130", marginBottom: 6 },
  brief: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.55)`, lineHeight: 18, marginBottom: 12 },

  // WHY NOW（绿框，green-700 = rgb(21,128,61)）
  whyNowBox: {
    marginBottom: 12,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    backgroundColor: "rgba(34,197,94,0.06)",
    borderColor: "rgba(34,197,94,0.22)",
  },
  whyNowLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: "rgba(21,128,61,0.8)", marginBottom: 4 },
  whyNowBody: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.75)`, lineHeight: 18 },

  // SOURCES
  section: { marginBottom: 12 },
  sectionLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: `rgba(${FG},0.55)`, marginBottom: 6 },
  sourceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 4,
    paddingRight: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: `rgba(${FG},0.05)`,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.06)`,
  },
  pillIcon: { width: 20, height: 20, borderRadius: 6, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  pillLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.7)` },

  // HOW I REASONED
  howBox: { marginBottom: 4, borderRadius: 16, borderWidth: 1, borderColor: `rgba(${FG},0.1)`, backgroundColor: `rgba(${FG},0.02)`, overflow: "hidden" },
  collapHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  rowCenter: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionLabelMuted: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: `rgba(${FG},0.55)` },
  stepCount: { fontSize: 11, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.4)` },
  howBody: { paddingHorizontal: 14, paddingBottom: 12, paddingTop: 2, gap: 8 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  stepNum: { width: 16, height: 16, borderRadius: 8, backgroundColor: `rgba(${FG},0.08)`, color: `rgba(${FG},0.55)`, fontSize: 10, fontFamily: "Inter_700Bold", textAlign: "center", lineHeight: 16, marginTop: 1 },
  stepLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.25, color: `rgba(${FG},0.45)`, marginBottom: 2 },
  stepDetail: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.75)`, lineHeight: 18 },
  flex1: { flex: 1 },

  // EXECUTION PLAN（粉色，--primary）
  planBox: { marginBottom: 12, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: `rgba(${PRIMARY},0.22)` },
  planLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: `rgb(${PRIMARY})` },
  planBody: { paddingHorizontal: 14, paddingBottom: 10, position: "relative" },
  planRail: { position: "absolute", left: 27, top: 6, bottom: 8, width: 1, backgroundColor: `rgba(${PRIMARY},0.2)` },
  execRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 6 },
  execIconBox: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.85)", borderWidth: 1, borderColor: `rgba(${FG},0.1)` },
  execText: { flex: 1, paddingTop: 2 },
  execStepText: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.85)`, lineHeight: 18 },
  execStepTool: { fontSize: 10, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.45)`, letterSpacing: 0.25, marginTop: 2 },
  invisible: { opacity: 0 },
  planPreparing: { marginBottom: 12, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: `rgba(${FG},0.1)`, backgroundColor: "rgba(255,255,255,0.55)" },
  preparingText: { flex: 1, fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.7)` },

  // 动作
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20 },
  btnSecondary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: `rgba(${FG},0.05)` },
  btnSecondaryText: { fontSize: 13, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.55)` },
  btnDone: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: `rgba(${FG},0.05)` },
  btnDoneText: { fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.55)` },
  btnPrimary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: "#1d2130" },
  btnPrimaryText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
