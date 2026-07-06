/**
 * Debug 滑出面板——ui-web `debug/DebugPanel.tsx`（665 行）的 RN 全量对应物
 * （页头齿轮触发；web 同位：齿轮 = debug，Setting 页只从抽屉菜单进）。
 *
 * 全量对齐 dev（本轮补齐先前缺口）：Connected backend、Generate Cards + Test Push、
 * Pipeline Phases（+ 运行计时 + active phase 提示）、Event Log、Crystallize/Skills/
 * Memories 三诊断子面板、Run Info、Connectors（每个 ACTIVE 账号一行 Reconnect =
 * re-pull 100 + re-run evolve）、Account（Sign Out + Delete Account）。
 *
 * 逻辑全走共享层：usePipeline / useInitTask / isInitTaskFresh /
 * buildConnectorInitTaskId（@pin-ai/state）+ deleteAccount / DeleteAccountError /
 * formatComposioToolkitName / formatOptionalComposioConnectionIdentity /
 * scheduleTestPush / fetchHealth（@pin-ai/core）。composio 由 AppShell 壳级持有传入
 * （web AppLayout 同位）。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, Clock, Loader2, Plug, RefreshCw, Trash2, X, Zap } from "lucide-react-native";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  fetchHealth,
  scheduleTestPush,
  deleteAccount,
  DeleteAccountError,
  formatComposioToolkitName,
  formatOptionalComposioConnectionIdentity,
} from "@pin-ai/core";
import {
  usePipeline,
  useInitTask,
  isInitTaskFresh,
  buildConnectorInitTaskId,
  type ComposioState,
} from "@pin-ai/state";

import { FullBleedOverlay } from "./FullBleedOverlay";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { heatProbeSnapshot } from "../../lib/heat-probe";
// __HEAT_AB__ 临时发热对照开关(定位完删)。
import { setHeatAbFlag, useHeatAbFlags, type HeatAbFlags } from "../../lib/heat-ab";
import SkillsPanel from "../profile/SkillsPanel";

const PANEL_WIDTH = 340;

const PHASES = ["planning", "generating", "evaluating", "complete"] as const;
const PHASE_LABELS: Record<string, string> = {
  planning: "Planning",
  generating: "Generating",
  evaluating: "Evaluating",
  complete: "Complete",
};
// dev PHASE_HINTS：运行时 active phase 的斜体提示。
const PHASE_HINTS: Record<string, string> = {
  planning: "Reading your profile & context...",
  generating: "Crafting intent cards...",
  evaluating: "Scoring relevance & quality...",
  complete: "Pipeline finished.",
};

const INK = "rgba(29,33,48,1)";
const ink = (a: number) => `rgba(29,33,48,${a})`;

// dev reconnect chip 配色（bg-red-100/emerald-100/amber-100/foreground-10 + 对应文字）。
const CHIP_TONES: Record<"neutral" | "running" | "ok" | "fail", { bg: string; fg: string }> = {
  fail: { bg: "#fee2e2", fg: "#dc2626" },
  ok: { bg: "#d1fae5", fg: "#047857" },
  running: { bg: "#fef3c7", fg: "#b45309" },
  neutral: { bg: ink(0.1), fg: ink(0.6) },
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

/** dev animate-spin（1s linear）。icon 不吃 transform → 包 Animated.View。 */
function Spin({ size, color, strokeWidth = 2 }: { size: number; color: string; strokeWidth?: number }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Loader2 size={size} color={color} strokeWidth={strokeWidth} />
    </Animated.View>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.section}>{children}</View>;
}

/** __HEAT_PROBE__ 临时发热探针面板(随探针整体删)。Release 真机看不到 console,
 *  这里把功耗状态(采集/视频/动画门控/渲染计数)开面板时 1s 轮询展示。 */
function HeatProbeSection({ open }: { open: boolean }) {
  const [snap, setSnap] = useState(() => heatProbeSnapshot());
  useEffect(() => {
    if (!open) return;
    setSnap(heatProbeSnapshot());
    const id = setInterval(() => setSnap(heatProbeSnapshot()), 1000);
    return () => clearInterval(id);
  }, [open]);
  return (
    <SectionCard>
      <Text style={styles.sectionLabel}>HEAT PROBE · up {snap.uptimeSec}s</Text>
      {snap.gauges.map(([k, v]) => (
        <View key={k} style={probeStyles.row}>
          <Text style={probeStyles.key}>{k}</Text>
          <Text style={probeStyles.val} numberOfLines={1}>{v}</Text>
        </View>
      ))}
      {snap.counters.map(([k, n]) => (
        <View key={k} style={probeStyles.row}>
          <Text style={probeStyles.key}>{k}</Text>
          <Text style={probeStyles.val}>{n}</Text>
        </View>
      ))}
      <Text style={[styles.sectionLabel, probeStyles.transHeader]}>TRANSITIONS</Text>
      {snap.transitions.slice(0, 12).map((tr, i) => (
        <Text key={`${tr.at}-${i}`} style={probeStyles.trans} numberOfLines={1}>
          {new Date(tr.at).toLocaleTimeString([], { hour12: false })} {tr.key} → {tr.value}
        </Text>
      ))}
    </SectionCard>
  );
}

const probeStyles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", gap: 8, marginTop: 2 },
  key: { fontSize: 11, color: ink(0.55), fontFamily: "Menlo" },
  val: { fontSize: 11, color: ink(0.85), fontFamily: "Menlo", flexShrink: 1 },
  transHeader: { marginTop: 8 },
  trans: { fontSize: 10, color: ink(0.5), fontFamily: "Menlo", marginTop: 2 },
});

/** __HEAT_AB__ 临时发热对照开关面板(随探针整体删)。三个渲染变体实时切换,同一
 *  散热基线下真机对比,定位 GPU 大头 = backdrop 视频 / sphere 混合 / sphere 遮罩。
 *  on(amber)=当前重路径仍在跑;off(green)=换成便宜变体。翻 off 后关面板感受降温。 */
function HeatAbSection() {
  const flags = useHeatAbFlags();
  const rows: Array<{ key: keyof HeatAbFlags; label: string; on: string; off: string }> = [
    // 卡片渲染引擎:原生 vs Skia GPU,对比发热(A/B 主开关)
    { key: "cardsSkia", label: "Cards engine", on: "SKIA", off: "native" },
    // 背景视频(已洗清,留作对照)
    { key: "backdropVideo", label: "Backdrop", on: "video", off: "static img" },
    // 水晶球相关(只影响 Ask PIN AI / 卡片聊天,NOW 无效)
    { key: "sphereBlend", label: "Sphere blend", on: "multiply", off: "off" },
    { key: "sphereMask", label: "Sphere mask", on: "feather", off: "hard circle" },
  ];
  return (
    <SectionCard>
      <Text style={styles.sectionLabel}>HEAT A/B</Text>
      {rows.map(({ key, label, on, off }) => {
        const isOn = flags[key];
        return (
          <Pressable
            key={key}
            onPress={() => setHeatAbFlag(key, !isOn)}
            accessibilityRole="switch"
            accessibilityState={{ checked: isOn }}
          >
            <View style={heatAbStyles.row}>
              <Text style={heatAbStyles.label}>{label}</Text>
              <View style={[heatAbStyles.pill, isOn ? heatAbStyles.pillOn : heatAbStyles.pillOff]}>
                <Text style={[heatAbStyles.pillText, isOn ? heatAbStyles.pillTextOn : heatAbStyles.pillTextOff]}>
                  {isOn ? on : off}
                </Text>
              </View>
            </View>
          </Pressable>
        );
      })}
      <Text style={heatAbStyles.hint}>Flip each off, close panel, feel heat drop → isolates the GPU hog.</Text>
    </SectionCard>
  );
}

const heatAbStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 5 },
  label: { fontSize: 12, color: ink(0.7), fontFamily: "Inter_500Medium" },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, minWidth: 84, alignItems: "center" },
  pillOn: { backgroundColor: "#fef3c7" },
  pillOff: { backgroundColor: "#d1fae5" },
  pillText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  pillTextOn: { color: "#b45309" },
  pillTextOff: { color: "#047857" },
  hint: { marginTop: 4, fontSize: 10, lineHeight: 14, color: ink(0.4), fontFamily: "Inter_400Regular" },
});

/** dev PhaseTimer：pipeline 运行时长（m s）。仅运行时显示。 */
function PhaseTimer({ isRunning }: { isRunning: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isRunning]);
  if (!isRunning) return null;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <Text style={styles.phaseTimer}>
      {mins > 0 ? `${mins}m ` : ""}
      {secs}s
    </Text>
  );
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
          ? "Failed — see console"
          : "Test Push (5s delay)";

  return (
    <Pressable
      onPress={() => void handle()}
      disabled={status === "scheduling" || status === "scheduled"}
      accessibilityRole="button"
      accessibilityLabel="Test push"
    >
      {({ pressed }) => (
        <View style={[styles.secondaryButton, pressed && styles.secondaryButtonPressed]}>
          <Bell size={12} color="#3f3f46" strokeWidth={2} />
          <Text style={styles.secondaryButtonText}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** dev ConnectorReconnectRow：单个 ACTIVE 账号一行 + Reconnect（re-pull 100 items
 *  + re-run evolve，幂等可重复）。useInitTask 只读轮询把结果 task 状态就地显示，
 *  终态自动停轮询。 */
function ConnectorReconnectRow({
  toolkit,
  toolkitLabel,
  identityLabel,
  connectedAccountId,
  onReconnect,
}: {
  toolkit: string;
  toolkitLabel: string;
  identityLabel: string | null;
  connectedAccountId: string;
  onReconnect: (
    toolkit: string,
    accountId: string,
  ) => Promise<{ ok: boolean; initTaskId?: string; error?: string }>;
}) {
  const taskId = buildConnectorInitTaskId(toolkit, connectedAccountId);
  const [restartToken, setRestartToken] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { task, terminal } = useInitTask(taskId, restartToken);
  const fresh = isInitTaskFresh(task);

  const handle = useCallback(async () => {
    setPending(true);
    setError(null);
    setRestartToken((n) => n + 1);
    try {
      const result = await onReconnect(toolkit, connectedAccountId);
      if (!result.ok) setError(result.error ?? "Reconnect failed");
    } finally {
      setPending(false);
    }
  }, [onReconnect, toolkit, connectedAccountId]);

  // 状态 chip（简短，占右缘）。
  let chipText: string | null = null;
  let chipTone: "neutral" | "running" | "ok" | "fail" = "neutral";
  if (error) {
    chipText = error;
    chipTone = "fail";
  } else if (pending) {
    chipText = "Enqueuing...";
    chipTone = "running";
  } else if (task && fresh) {
    if (task.status === "queued") {
      chipText = "Queued";
      chipTone = "running";
    } else if (task.status === "running") {
      const stage = (task.progress?.stage as string | undefined) ?? "running";
      chipText = `Running · ${stage}`;
      chipTone = "running";
    } else if (task.status === "succeeded") {
      const memWritten = (task.result?.memoriesWritten as number | undefined) ?? 0;
      const skillsAdded = (task.result?.skillsAdded as number | undefined) ?? 0;
      const rawIns = (task.result?.rawInserted as number | undefined) ?? 0;
      chipText = `Done · ${rawIns} raw, ${memWritten} mem, ${skillsAdded} skill`;
      chipTone = "ok";
    } else if (task.status === "skipped") {
      chipText = `Skipped: ${(task.result?.reason as string | undefined) ?? "—"}`;
      chipTone = "neutral";
    } else {
      chipText = task.status;
      chipTone = "fail";
    }
  }

  const tone = CHIP_TONES[chipTone];
  const isWorking = pending || (!!task && !terminal && fresh);

  return (
    <View style={styles.reconnectRow}>
      <View style={styles.reconnectMain}>
        <View style={styles.reconnectLabelRow}>
          <Text style={styles.reconnectToolkit}>{toolkitLabel}</Text>
          {identityLabel ? (
            <Text style={styles.reconnectIdentity} numberOfLines={1}>
              {identityLabel}
            </Text>
          ) : null}
        </View>
        {chipText ? (
          <View style={[styles.chip, { backgroundColor: tone.bg }]}>
            <Text style={[styles.chipText, { color: tone.fg }]} numberOfLines={1}>
              {chipText}
            </Text>
          </View>
        ) : null}
      </View>
      <Pressable
        onPress={() => void handle()}
        disabled={isWorking}
        accessibilityRole="button"
        accessibilityLabel="Reconnect"
        hitSlop={4}
      >
        {({ pressed }) => (
          <View style={[styles.reconnectBtn, pressed && styles.reconnectBtnPressed, isWorking && styles.disabled]}>
            {isWorking ? <Spin size={11} color={ink(0.65)} /> : <RefreshCw size={11} strokeWidth={1.6} color={ink(0.65)} />}
            <Text style={styles.reconnectBtnText}>Reconnect</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

/** dev DeleteAccountButton：永久删账 + 登出。两击内联确认（webview confirm 会 hang，
 *  同 AccountPanel 取消订阅流）。成功后 onDeleteAccount 登出并卸载本组件，只处理错误路径。 */
function DeleteAccountButton({ onDeleteAccount }: { onDeleteAccount: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = useCallback(async () => {
    if (pending) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onDeleteAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
      setConfirming(false);
    }
  }, [confirming, pending, onDeleteAccount]);

  return (
    <View style={styles.deleteWrap}>
      <Pressable onPress={() => void handle()} disabled={pending} accessibilityRole="button">
        {({ pressed }) => (
          <View
            style={[
              styles.deleteBtn,
              confirming ? styles.deleteBtnConfirming : styles.deleteBtnIdle,
              pressed && (confirming ? styles.deleteBtnConfirmingPressed : styles.deleteBtnIdlePressed),
              pending && styles.disabled,
            ]}
          >
            {pending ? (
              <Spin size={12} color={confirming ? "#fff" : "#ef4444"} />
            ) : (
              <Trash2 size={12} strokeWidth={1.8} color={confirming ? "#fff" : "#ef4444"} />
            )}
            <Text style={[styles.deleteBtnText, confirming && styles.deleteBtnTextConfirming]}>
              {pending ? "Deleting..." : confirming ? "Tap again to permanently delete" : "Delete Account"}
            </Text>
          </View>
        )}
      </Pressable>
      {confirming && !pending ? (
        <Text style={styles.deleteHint}>
          Erases your account, connected data, memories, chats, and billing across every device. This
          can't be undone.{" "}
          <Text style={styles.deleteCancel} onPress={() => setConfirming(false)}>
            Cancel
          </Text>
        </Text>
      ) : null}
      {error ? <Text style={styles.deleteError}>Delete failed: {error}</Text> : null}
    </View>
  );
}

export default function DebugPanel({
  open,
  onClose,
  onSignOut,
  composio,
  onDeleteAccount,
}: {
  open: boolean;
  onClose: () => void;
  onSignOut: () => Promise<void>;
  composio: ComposioState;
  onDeleteAccount?: () => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const { run, isRunning, generate } = usePipeline();
  const [devLabel, setDevLabel] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      progress.value = withSpring(1, { damping: 30, stiffness: 300, overshootClamping: true });
    } else {
      progress.value = withTiming(0, { duration: 200 }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
  }, [open, progress]);

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

  const activeConns = composio.connections.filter((c) => c.status === "ACTIVE");

  if (!mounted) return null;

  return (
    // 出血到物理屏满高（FullBleedOverlay），否则面板顶部露一条、底部 Delete
    // Account 溢出可视区滑不到。内容用 insets 避开刘海/home-indicator。
    <FullBleedOverlay>
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]}>
        <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.panel, { width: PANEL_WIDTH }, panelStyle]}>
        <BlurView intensity={80} tint="light" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.panelTint]} />

        {/* header 内容避开刘海（出血后自物理屏顶算）。 */}
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <Text style={styles.headerTitle}>Debug</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close debug">
            <X size={18} color="#71717a" strokeWidth={1.5} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 24 }]}
        >
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

          {/* __HEAT_PROBE__ 临时发热探针(随探针整体删)。 */}
          <HeatProbeSection open={open} />
          {/* __HEAT_AB__ 临时发热对照开关(随探针整体删)。 */}
          <HeatAbSection />

          <SectionCard>
            <View style={styles.sectionTitleRow}>
              <Zap size={14} color={ink(0.4)} strokeWidth={1.5} />
              <Text style={styles.sectionTitle}>Generate Cards</Text>
            </View>
            <Pressable onPress={generate} disabled={isRunning} accessibilityRole="button" accessibilityLabel="Generate cards">
              {({ pressed }) => (
                <View style={[styles.primaryButton, pressed && styles.primaryButtonPressed, isRunning && styles.disabled]}>
                  <Zap size={12} color="#fff" strokeWidth={2} />
                  <Text style={styles.primaryButtonText}>{isRunning ? "Running..." : "Generate"}</Text>
                </View>
              )}
            </Pressable>
            <TestPushButton />
          </SectionCard>

          <SectionCard>
            <View style={styles.phaseHeaderRow}>
              <Text style={styles.sectionLabel}>PIPELINE PHASES</Text>
              <PhaseTimer isRunning={isRunning} />
            </View>
            <View style={styles.phaseRow}>
              {PHASES.map((phase) => {
                const s = phaseStatus(phase, run.activePhase, run.status);
                return (
                  <View key={phase} style={[styles.phaseChip, s === "active" && styles.phaseActive, s === "done" && styles.phaseDone]}>
                    <Text style={[styles.phaseText, s === "active" && styles.phaseTextActive, s === "done" && styles.phaseTextDone]}>
                      {PHASE_LABELS[phase]}
                    </Text>
                  </View>
                );
              })}
            </View>
            {isRunning && run.activePhase ? (
              <Text style={styles.phaseHint}>{PHASE_HINTS[run.activePhase] ?? "Processing..."}</Text>
            ) : null}
          </SectionCard>

          <SectionCard>
            <View style={styles.sectionTitleRow}>
              <Clock size={12} color={ink(0.4)} strokeWidth={1.5} />
              <Text style={styles.sectionLabel}>EVENT LOG</Text>
              <View style={styles.flexSpacer} />
              <Text style={styles.eventCount}>{run.logEntries.length} events</Text>
            </View>
            {/* dev 同为全量渲染（新→旧）；长列表随面板 body ScrollView 滚动
                （不设 maxHeight 内滚，避免嵌套纵向滚动手势冲突）。 */}
            <View>
              {run.logEntries.length === 0 ? (
                <Text style={styles.logEmpty}>No events yet</Text>
              ) : (
                [...run.logEntries]
                  .reverse()
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

          {/* dev 顺序：Event Log 后接 Skills 诊断子面板。Crystallize/Memories
              面板随 lifelong-memory 退役（web DebugPanel 同步已删）：crystallize
              agent 已删除，pai_memory 已被 L2 portrait 取代。 */}
          <SkillsPanel enabled={open} />

          <SectionCard>
            <Text style={styles.sectionLabel}>RUN INFO</Text>
            <View style={styles.infoGrid}>
              <Text style={styles.infoKey}>Status</Text>
              <Text style={styles.infoVal}>{run.status || "—"}</Text>
              <Text style={styles.infoKey}>Started</Text>
              <Text style={styles.infoValMono}>
                {run.startedAt
                  ? new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                  : "—"}
              </Text>
              <Text style={styles.infoKey}>Completed</Text>
              <Text style={styles.infoValMono}>
                {run.completedAt
                  ? new Date(run.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
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

          {/* dev Connectors：每个 ACTIVE 账号一行 Reconnect。 */}
          <SectionCard>
            <View style={styles.sectionTitleRow}>
              <Plug size={14} color={ink(0.4)} strokeWidth={1.5} />
              <Text style={styles.sectionTitle}>Connectors</Text>
              <View style={styles.flexSpacer} />
              <Text style={styles.eventCount}>{activeConns.length} active</Text>
            </View>
            <Text style={styles.connectorHint}>
              Reconnect re-pulls 100 items and re-runs evolve for that account. Existing raw rows are kept.
            </Text>
            {composio.loadingConns && composio.connections.length === 0 ? (
              <Text style={styles.connectorMuted}>Loading connections…</Text>
            ) : activeConns.length === 0 ? (
              <Text style={styles.connectorMuted}>
                No active connections. Visit the Data Connections page to set one up.
              </Text>
            ) : (
              <View style={styles.reconnectList}>
                {activeConns
                  .filter((conn) => conn.connectedAccountId)
                  .map((conn) => {
                    const accountId = conn.connectedAccountId as string;
                    const identity = formatOptionalComposioConnectionIdentity(conn, composio.connections);
                    return (
                      <ConnectorReconnectRow
                        key={accountId}
                        toolkit={conn.toolkit}
                        toolkitLabel={formatComposioToolkitName(conn.toolkit)}
                        identityLabel={identity}
                        connectedAccountId={accountId}
                        onReconnect={composio.reconnectAccount}
                      />
                    );
                  })}
              </View>
            )}
          </SectionCard>

          <SectionCard>
            <Text style={styles.sectionLabel}>ACCOUNT</Text>
            <Pressable
              onPress={() => {
                // dev DebugPanel: confirm("Sign out?") 通过才 signOut。RN 的系统
                // 对话框等价物 = Alert.alert（同 DeviceConnections 移除设备的既有模式）。
                Alert.alert("Sign out?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Sign Out",
                    onPress: () => {
                      setSigningOut(true);
                      void onSignOut().finally(() => setSigningOut(false));
                    },
                  },
                ]);
              }}
              disabled={signingOut}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
            >
              {({ pressed }) => (
                <View style={[styles.outlineButton, pressed && styles.outlineButtonPressed, signingOut && styles.disabled]}>
                  <Text style={styles.outlineButtonText}>{signingOut ? "Signing out..." : "Sign Out"}</Text>
                </View>
              )}
            </Pressable>
            {onDeleteAccount ? <DeleteAccountButton onDeleteAccount={onDeleteAccount} /> : null}
          </SectionCard>
        </ScrollView>
      </Animated.View>
    </FullBleedOverlay>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: "rgba(0,0,0,0.2)" },
  panel: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0, // 撑满出血 root（替代旧的 height=windowHeight，那会从刘海下起 + 全屏高 → 底部溢出）
    overflow: "hidden",
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: ink(0.1),
  },
  panelTint: { backgroundColor: "rgba(255,255,255,0.8)" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    // paddingTop 由 inline insets.top + 12 给（避开刘海）。
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: INK },
  body: { flex: 1 },
  // paddingBottom 由 inline insets.bottom + 24 给（Delete Account 滑过 home indicator）。
  bodyContent: { paddingHorizontal: 20, gap: 14 },
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
  backendLabel: { fontSize: 10, letterSpacing: 0.8, color: "rgba(4,120,87,0.6)", fontFamily: "Inter_500Medium" },
  backendValue: { fontSize: 12, color: "#065f46", fontFamily: "Inter_600SemiBold" },
  section: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ink(0.1),
    backgroundColor: ink(0.03),
    padding: 14,
    gap: 8,
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: { fontSize: 12, color: ink(0.5), fontFamily: "Inter_500Medium" },
  sectionLabel: { fontSize: 11, letterSpacing: 0.8, color: ink(0.4), fontFamily: "Inter_500Medium" },
  flexSpacer: { flex: 1 },
  eventCount: { fontSize: 10, color: ink(0.3), fontFamily: "Menlo" },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    backgroundColor: INK,
    paddingVertical: 8,
  },
  primaryButtonPressed: { opacity: 0.85 },
  primaryButtonText: { fontSize: 11, color: "#fff", fontFamily: "Inter_600SemiBold" },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    backgroundColor: ink(0.06),
    paddingVertical: 8,
  },
  secondaryButtonPressed: { backgroundColor: ink(0.1) },
  secondaryButtonText: { fontSize: 11, color: "#3f3f46", fontFamily: "Inter_600SemiBold" },
  outlineButton: { alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: ink(0.15), paddingVertical: 9 },
  outlineButtonPressed: { backgroundColor: ink(0.05) },
  outlineButtonText: { fontSize: 11, color: ink(0.6), fontFamily: "Inter_500Medium" },
  disabled: { opacity: 0.4 },

  // phases
  phaseHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  phaseTimer: { fontSize: 11, color: ink(0.4), fontFamily: "Menlo", fontVariant: ["tabular-nums"] },
  phaseRow: { flexDirection: "row", gap: 6 },
  phaseChip: { flex: 1, alignItems: "center", borderRadius: 999, backgroundColor: ink(0.1), paddingVertical: 6 },
  phaseActive: { backgroundColor: "#3b82f6" },
  phaseDone: { backgroundColor: "#d1fae5" },
  phaseText: { fontSize: 10, color: ink(0.4), fontFamily: "Inter_600SemiBold" },
  phaseTextActive: { color: "#fff" },
  phaseTextDone: { color: "#047857" },
  phaseHint: { fontSize: 11, color: ink(0.4), fontFamily: "Inter_400Regular", fontStyle: "italic" },

  // event log
  logEmpty: { fontSize: 11, color: ink(0.3), textAlign: "center", paddingVertical: 16, fontFamily: "Inter_400Regular" },
  logRow: { borderLeftWidth: 2, borderLeftColor: ink(0.1), paddingLeft: 10, paddingVertical: 6 },
  logMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  logTime: { fontSize: 10, color: ink(0.3), fontFamily: "Menlo" },
  logKind: {
    fontSize: 10,
    color: ink(0.4),
    backgroundColor: ink(0.1),
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: "hidden",
    fontFamily: "Inter_500Medium",
  },
  logTitle: { marginTop: 2, fontSize: 12, color: ink(0.7), fontFamily: "Inter_500Medium" },
  logDetail: { marginTop: 1, fontSize: 11, color: ink(0.4), fontFamily: "Inter_400Regular" },

  // run info
  infoGrid: { flexDirection: "row", flexWrap: "wrap", rowGap: 6 },
  infoKey: { width: "38%", fontSize: 11, color: ink(0.4), fontFamily: "Inter_400Regular" },
  infoVal: { width: "62%", fontSize: 11, color: ink(0.7), fontFamily: "Inter_500Medium" },
  infoValMono: { width: "62%", fontSize: 11, color: ink(0.5), fontFamily: "Menlo" },
  errorBox: { borderRadius: 8, borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fef2f2", paddingHorizontal: 12, paddingVertical: 8 },
  errorText: { fontSize: 11, color: "#dc2626", fontFamily: "Inter_400Regular" },

  // connectors
  connectorHint: { fontSize: 10, lineHeight: 15, color: ink(0.4), fontFamily: "Inter_400Regular" },
  connectorMuted: { fontSize: 11, color: ink(0.35), fontFamily: "Inter_400Regular", paddingVertical: 6 },
  reconnectList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ink(0.05) },
  reconnectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ink(0.05),
  },
  reconnectMain: { flex: 1, minWidth: 0 },
  reconnectLabelRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  reconnectToolkit: { fontSize: 11, color: ink(0.75), fontFamily: "Inter_500Medium" },
  reconnectIdentity: { flex: 1, minWidth: 0, fontSize: 11, color: ink(0.45), fontFamily: "Inter_400Regular" },
  chip: { alignSelf: "flex-start", marginTop: 2, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  chipText: { fontSize: 10, fontFamily: "Inter_500Medium" },
  reconnectBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ink(0.15),
    backgroundColor: "rgba(255,255,255,0.55)",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  reconnectBtnPressed: { backgroundColor: "rgba(255,255,255,0.85)" },
  reconnectBtnText: { fontSize: 11, color: ink(0.65), fontFamily: "Inter_500Medium" },

  // delete account
  deleteWrap: { marginTop: 8, gap: 6 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 8,
  },
  deleteBtnIdle: { borderColor: "rgba(252,165,165,0.6)", backgroundColor: "transparent" },
  deleteBtnIdlePressed: { backgroundColor: "#fef2f2" },
  deleteBtnConfirming: { borderColor: "#ef4444", backgroundColor: "#ef4444" },
  deleteBtnConfirmingPressed: { backgroundColor: "#dc2626" },
  deleteBtnText: { fontSize: 11, color: "#ef4444", fontFamily: "Inter_500Medium" },
  deleteBtnTextConfirming: { color: "#fff" },
  deleteHint: { fontSize: 10, lineHeight: 14, color: ink(0.45), fontFamily: "Inter_400Regular" },
  deleteCancel: { color: ink(0.6), fontFamily: "Inter_500Medium", textDecorationLine: "underline" },
  deleteError: { fontSize: 10, lineHeight: 14, color: "#ef4444", fontFamily: "Inter_400Regular" },
});
