/**
 * Debug 滑出面板——web common/DebugPanel 的 RN 对应物（页头齿轮触发，
 * web 同位：齿轮 = debug，Setting 页只从抽屉菜单进）。
 * 已移植：Connected backend（fetchHealth dev_label，多 worktree 手机
 * 测试的关键信息）、Generate Cards + Test Push、Pipeline Phases、
 * Event Log、Run Info、Sign Out。状态机直接消费 @pin-ai/state 的
 * usePipeline（与 web 同一状态机；persist 暂缺=面板存活期内有效）。
 * 未移植（web 有、此处记账）：Crystallize/Skills/Memories 诊断子面板
 * （app 级组件待 RN 化）、Composio 重连行（useComposio 还在 web app
 * 层未下沉 state 包）、Delete Account（mobile 无该链路）。
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import { Bell, Clock, Plug, X, Zap } from "lucide-react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { fetchHealth, scheduleTestPush } from "@pin-ai/core";
import { usePipeline } from "@pin-ai/state";

const PANEL_WIDTH = 340;

const PHASES = ["planning", "generating", "evaluating", "complete"] as const;
const PHASE_LABELS: Record<string, string> = {
  planning: "Planning",
  generating: "Generating",
  evaluating: "Evaluating",
  complete: "Complete",
};

function phaseStatus(phase: string, activePhase: string | null, status: string) {
  if (status === "complete" || status === "done") return "done";
  if (!activePhase) return "pending";
  const activeIdx = PHASES.indexOf(activePhase as (typeof PHASES)[number]);
  const thisIdx = PHASES.indexOf(phase as (typeof PHASES)[number]);
  if (thisIdx < 0 || activeIdx < 0) return "pending";
  if (thisIdx < activeIdx) return "done";
  if (thisIdx === activeIdx) return "active";
  return "pending";
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.section}>{children}</View>;
}

function TestPushButton() {
  const [status, setStatus] = useState<"idle" | "scheduling" | "scheduled" | "failed">("idle");
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (status !== "scheduled" || secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft(secondsLeft - 1), 1000);
    return () => clearTimeout(t);
  }, [status, secondsLeft]);

  useEffect(() => {
    if (status === "scheduled" && secondsLeft === 0) {
      const t = setTimeout(() => setStatus("idle"), 2000);
      return () => clearTimeout(t);
    }
  }, [status, secondsLeft]);

  const handle = async () => {
    if (status === "scheduling" || status === "scheduled") return;
    setStatus("scheduling");
    try {
      const { scheduledInSeconds } = await scheduleTestPush();
      setSecondsLeft(scheduledInSeconds);
      setStatus("scheduled");
    } catch {
      setStatus("failed");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  const label =
    status === "scheduling"
      ? "Scheduling..."
      : status === "scheduled"
        ? `Background the app · ${secondsLeft}s`
        : status === "failed"
          ? "Failed"
          : "Test Push (5s delay)";

  return (
    <Pressable
      onPress={() => void handle()}
      disabled={status === "scheduling" || status === "scheduled"}
      accessibilityRole="button"
      accessibilityLabel="Test push"
      style={styles.secondaryButton}
    >
      <Bell size={12} color="#3f3f46" strokeWidth={2} />
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

export default function DebugPanel({
  open,
  onClose,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  onSignOut: () => Promise<void>;
}) {
  const { height } = useWindowDimensions();
  const { run, isRunning, generate } = usePipeline();
  const [devLabel, setDevLabel] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // web: spring(damping 30, stiffness 300)。
      progress.value = withSpring(1, { damping: 30, stiffness: 300, overshootClamping: true });
    } else {
      progress.value = withTiming(0, { duration: 200 }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
  }, [open, progress]);

  // 打开时拉后端 dev_label（本地 dev 显示连的是哪个 worktree；prod 无）。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchHealth()
      .then((h) => {
        if (!cancelled) setDevLabel(h.dev_label ?? null);
      })
      .catch(() => {
        if (!cancelled) setDevLabel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * PANEL_WIDTH }],
  }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.panel, { width: PANEL_WIDTH, height }, panelStyle]}>
        {/* web: bg-white/80 + backdrop-blur-2xl + 左缘细边。 */}
        <BlurView intensity={80} tint="light" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.panelTint]} />

        <View style={styles.header}>
          <Text style={styles.headerTitle}>Debug</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close debug">
            <X size={18} color="#71717a" strokeWidth={1.5} />
          </Pressable>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {devLabel ? (
            <View style={styles.backendCard}>
              <Plug size={13} color="#059669" strokeWidth={1.5} />
              <View style={styles.backendTextWrap}>
                <Text style={styles.backendLabel}>CONNECTED BACKEND</Text>
                <Text style={styles.backendValue} numberOfLines={1}>
                  {devLabel}
                </Text>
              </View>
            </View>
          ) : null}

          <SectionCard>
            <View style={styles.sectionTitleRow}>
              <Zap size={14} color="rgba(29,33,48,0.4)" strokeWidth={1.5} />
              <Text style={styles.sectionTitle}>Generate Cards</Text>
            </View>
            <Pressable
              onPress={generate}
              disabled={isRunning}
              accessibilityRole="button"
              accessibilityLabel="Generate cards"
              style={[styles.primaryButton, isRunning && styles.disabled]}
            >
              <Zap size={12} color="#fff" strokeWidth={2} />
              <Text style={styles.primaryButtonText}>{isRunning ? "Running..." : "Generate"}</Text>
            </Pressable>
            <TestPushButton />
          </SectionCard>

          <SectionCard>
            <Text style={styles.sectionLabel}>PIPELINE PHASES</Text>
            <View style={styles.phaseRow}>
              {PHASES.map((phase) => {
                const s = phaseStatus(phase, run.activePhase, run.status);
                return (
                  <View
                    key={phase}
                    style={[
                      styles.phaseChip,
                      s === "active" && styles.phaseActive,
                      s === "done" && styles.phaseDone,
                    ]}
                  >
                    <Text
                      style={[
                        styles.phaseText,
                        s === "active" && styles.phaseTextActive,
                        s === "done" && styles.phaseTextDone,
                      ]}
                    >
                      {PHASE_LABELS[phase]}
                    </Text>
                  </View>
                );
              })}
            </View>
          </SectionCard>

          <SectionCard>
            <View style={styles.sectionTitleRow}>
              <Clock size={12} color="rgba(29,33,48,0.4)" strokeWidth={1.5} />
              <Text style={styles.sectionLabel}>EVENT LOG</Text>
              <View style={styles.flexSpacer} />
              <Text style={styles.eventCount}>{run.logEntries.length} events</Text>
            </View>
            <View style={styles.logBox}>
              {run.logEntries.length === 0 ? (
                <Text style={styles.logEmpty}>No events yet</Text>
              ) : (
                [...run.logEntries]
                  .reverse()
                  .slice(0, 30)
                  .map((entry) => (
                    <View key={entry.id} style={styles.logRow}>
                      <View style={styles.logMeta}>
                        <Text style={styles.logTime}>
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </Text>
                        <Text style={styles.logKind}>{entry.kind}</Text>
                      </View>
                      <Text style={styles.logTitle}>{entry.title}</Text>
                      {entry.detail ? (
                        <Text style={styles.logDetail} numberOfLines={2}>
                          {entry.detail}
                        </Text>
                      ) : null}
                    </View>
                  ))
              )}
            </View>
          </SectionCard>

          <SectionCard>
            <Text style={styles.sectionLabel}>RUN INFO</Text>
            <View style={styles.infoGrid}>
              <Text style={styles.infoKey}>Status</Text>
              <Text style={styles.infoVal}>{run.status || "—"}</Text>
              <Text style={styles.infoKey}>Started</Text>
              <Text style={styles.infoValMono}>
                {run.startedAt
                  ? new Date(run.startedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "—"}
              </Text>
              <Text style={styles.infoKey}>Completed</Text>
              <Text style={styles.infoValMono}>
                {run.completedAt
                  ? new Date(run.completedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "—"}
              </Text>
              <Text style={styles.infoKey}>Final Cards</Text>
              <Text style={styles.infoVal}>{run.finalCards.length}</Text>
            </View>
            {run.error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{run.error}</Text>
              </View>
            ) : null}
          </SectionCard>

          <SectionCard>
            <Text style={styles.sectionLabel}>ACCOUNT</Text>
            <Pressable
              onPress={() => {
                setSigningOut(true);
                void onSignOut().finally(() => setSigningOut(false));
              }}
              disabled={signingOut}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={[styles.outlineButton, signingOut && styles.disabled]}
            >
              <Text style={styles.outlineButtonText}>
                {signingOut ? "Signing out..." : "Sign Out"}
              </Text>
            </Pressable>
          </SectionCard>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const INK = "rgba(29,33,48,1)";

const styles = StyleSheet.create({
  dim: { backgroundColor: "rgba(0,0,0,0.2)" },
  panel: {
    position: "absolute",
    right: 0,
    top: 0,
    overflow: "hidden",
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "rgba(29,33,48,0.1)",
  },
  panelTint: { backgroundColor: "rgba(255,255,255,0.8)" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 64,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: INK },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 20, paddingBottom: 24, gap: 14 },
  backendCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#a7f3d0",
    backgroundColor: "rgba(236,253,245,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backendTextWrap: { flex: 1, minWidth: 0 },
  backendLabel: {
    fontSize: 10,
    letterSpacing: 0.8,
    color: "rgba(4,120,87,0.6)",
    fontFamily: "Inter_500Medium",
  },
  backendValue: { fontSize: 12, color: "#065f46", fontFamily: "Inter_600SemiBold" },
  section: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(29,33,48,0.1)",
    backgroundColor: "rgba(29,33,48,0.03)",
    padding: 14,
    gap: 8,
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: { fontSize: 12, color: "rgba(29,33,48,0.5)", fontFamily: "Inter_500Medium" },
  sectionLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
    color: "rgba(29,33,48,0.4)",
    fontFamily: "Inter_500Medium",
  },
  flexSpacer: { flex: 1 },
  eventCount: { fontSize: 10, color: "rgba(29,33,48,0.3)", fontFamily: "Menlo" },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    backgroundColor: INK,
    paddingVertical: 8,
  },
  primaryButtonText: { fontSize: 11, color: "#fff", fontFamily: "Inter_600SemiBold" },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    backgroundColor: "rgba(29,33,48,0.06)",
    paddingVertical: 8,
  },
  secondaryButtonText: { fontSize: 11, color: "#3f3f46", fontFamily: "Inter_600SemiBold" },
  outlineButton: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(29,33,48,0.15)",
    paddingVertical: 9,
  },
  outlineButtonText: { fontSize: 11, color: "rgba(29,33,48,0.6)", fontFamily: "Inter_500Medium" },
  disabled: { opacity: 0.4 },
  phaseRow: { flexDirection: "row", gap: 6 },
  phaseChip: {
    flex: 1,
    alignItems: "center",
    borderRadius: 999,
    backgroundColor: "rgba(29,33,48,0.1)",
    paddingVertical: 6,
  },
  phaseActive: { backgroundColor: "#3b82f6" },
  phaseDone: { backgroundColor: "#d1fae5" },
  phaseText: { fontSize: 10, color: "rgba(29,33,48,0.4)", fontFamily: "Inter_600SemiBold" },
  phaseTextActive: { color: "#fff" },
  phaseTextDone: { color: "#047857" },
  logBox: { maxHeight: 240 },
  logEmpty: {
    fontSize: 11,
    color: "rgba(29,33,48,0.3)",
    textAlign: "center",
    paddingVertical: 16,
    fontFamily: "Inter_400Regular",
  },
  logRow: {
    borderLeftWidth: 2,
    borderLeftColor: "rgba(29,33,48,0.1)",
    paddingLeft: 10,
    paddingVertical: 6,
  },
  logMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  logTime: { fontSize: 10, color: "rgba(29,33,48,0.3)", fontFamily: "Menlo" },
  logKind: {
    fontSize: 10,
    color: "rgba(29,33,48,0.4)",
    backgroundColor: "rgba(29,33,48,0.1)",
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: "hidden",
    fontFamily: "Inter_500Medium",
  },
  logTitle: { marginTop: 2, fontSize: 12, color: "rgba(29,33,48,0.7)", fontFamily: "Inter_500Medium" },
  logDetail: { marginTop: 1, fontSize: 11, color: "rgba(29,33,48,0.4)", fontFamily: "Inter_400Regular" },
  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 6,
  },
  infoKey: { width: "38%", fontSize: 11, color: "rgba(29,33,48,0.4)", fontFamily: "Inter_400Regular" },
  infoVal: { width: "62%", fontSize: 11, color: "rgba(29,33,48,0.7)", fontFamily: "Inter_500Medium" },
  infoValMono: { width: "62%", fontSize: 11, color: "rgba(29,33,48,0.5)", fontFamily: "Menlo" },
  errorBox: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fef2f2",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: { fontSize: 11, color: "#dc2626", fontFamily: "Inter_400Regular" },
});
