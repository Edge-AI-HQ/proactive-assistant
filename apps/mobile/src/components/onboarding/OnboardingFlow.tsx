/**
 * First-run onboarding —— dev `components/onboarding/OnboardingFlow.tsx` 的 RN 全量移植。
 * App.tsx 以 `settings.onboardingCompletedAt == null` gate；最后一步 Done 由
 * onComplete（App.tsx 持有 patch）盖章服务端，成功后 App 切主壳。
 * 三步皆可 Skip；只有第 3 步结束才盖章——中途杀 App 重开从第 1 步重来（dev 同语义）。
 *
 * 步骤复用已迁 RN 的整块组件（与 dev 复用 web 组件同构）：
 *   step1 = DataConnections（连接数据源）
 *   step2 = AmbientSourceControlsPanel + VoiceIdentitySettings（ambient + 声纹）
 *   step3 = AmbientModelSetupStep（Gemma 2B 端侧模型）
 * 退出机 = dev 逐字：Done 时若有 connector insight 在跑 → 800ms 宽限 →
 * InsightWaitPage（等第一次拉取的画像预览）→ ready 后 insight 全页（Enter PIN AI）→ finish。
 *
 * 平台注（非阉割）：dev 的 isNative 分支在 RN 恒为 native——subtitle 用 *Native
 * 文案、step3 直接渲染模型步（web 的占位卡分支在 RN 无意义）；RN 版
 * AmbientSourceControlsPanel / VoiceIdentitySettings 需要显式 userId（web 版
 * 自取 auth），故本组件多一个 userId prop。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CheckCircle2, ChevronRight, Database, Sparkles, UserRound } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useComposio } from "@pin-ai/state";

import { FlowBackdrop } from "../../screens/BootScreen";
import AmbientSourceControlsPanel from "../ambient/AmbientSourceControlsPanel";
import VoiceIdentitySettings from "../ambient/VoiceIdentitySettings";
import DataConnections from "../connect/DataConnections";
import AmbientModelSetupStep from "./AmbientModelSetupStep";
import ConnectorOnboardingInsight, {
  StrongCard,
  type ConnectorInsightStatus,
} from "./ConnectorOnboardingInsight";
import Spin from "./Spin";

interface OnboardingFlowProps {
  userId: string | null;
  onComplete: () => Promise<void> | void;
}

type Step = 1 | 2 | 3;
type ExitStage = "flow" | "waiting" | "summary";

const INSIGHT_WAIT_GRACE_MS = 800;

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BACKGROUND = "hsl(220, 30%, 96%)";
const EMERALD_600 = "#059669";
const emerald = (a: number) => `rgba(16, 185, 129, ${a})`;

interface StepHeaderProps {
  step: Step;
  title: string;
  subtitle: string;
}

function StepHeader({ step, title, subtitle }: StepHeaderProps) {
  const { t } = useTranslation("onboarding");
  return (
    <View style={styles.stepHeader}>
      <View style={styles.stepMetaRow}>
        <Text style={styles.stepOf}>{t("stepOf", { step, total: 3 })}</Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(step / 3) * 100}%` }]} />
        </View>
      </View>
      <Text style={styles.stepTitle}>{title}</Text>
      <Text style={styles.stepSubtitle}>{subtitle}</Text>
    </View>
  );
}

/** dev InsightWaitPage 的 w-2/3 animate-pulse 进度条（2s 1↔0.5 呼吸）。 */
function PulseBarFill() {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(
      withTiming(0.5, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
      -1,
      true,
    );
    return () => cancelAnimation(o);
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[styles.waitProgressFill, style]} />;
}

function InsightWaitPage() {
  const { t } = useTranslation("onboarding");
  const steps = [
    {
      label: t("insightWait.steps.reading.label"),
      detail: t("insightWait.steps.reading.detail"),
      icon: Database,
    },
    {
      label: t("insightWait.steps.signals.label"),
      detail: t("insightWait.steps.signals.detail"),
      icon: Sparkles,
    },
    {
      label: t("insightWait.steps.composing.label"),
      detail: t("insightWait.steps.composing.detail"),
      icon: UserRound,
    },
  ];

  return (
    <StrongCard style={{ flex: 1 }}>
      <View style={styles.waitHeader}>
        <View style={styles.waitHeaderIcon}>
          <Spin size={15} color={EMERALD_600} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.waitEyebrow}>{t("insightWait.eyebrow")}</Text>
          <Text style={styles.waitHeading}>{t("insightWait.heading")}</Text>
          <Text style={styles.waitDescription}>{t("insightWait.description")}</Text>
        </View>
      </View>

      <View style={styles.waitBody}>
        <View style={styles.waitBox}>
          <View style={styles.waitBoxHeadRow}>
            <Text style={styles.waitBoxTitle}>{t("insightWait.firstDataPull")}</Text>
            <Text style={styles.waitLivePill}>{t("insightWait.live")}</Text>
          </View>

          <View style={styles.waitProgressTrack}>
            <PulseBarFill />
          </View>

          <View style={{ marginTop: 20, gap: 16 }}>
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <View key={step.label} style={styles.waitStepRow}>
                  <View style={styles.waitStepIconBox}>
                    <Icon size={15} strokeWidth={1.8} color={fg(0.5)} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.waitStepLabel}>{step.label}</Text>
                    <Text style={styles.waitStepDetail}>{step.detail}</Text>
                  </View>
                  <View style={styles.waitStepSpinner}>
                    <Spin size={11} color={EMERALD_600} />
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      </View>

      <View style={styles.waitFooter}>
        <CheckCircle2 size={14} color={fg(0.45)} style={{ marginTop: 2 }} />
        <Text style={styles.waitFooterText}>{t("insightWait.footer")}</Text>
      </View>
    </StrongCard>
  );
}

export default function OnboardingFlow({ userId, onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation(["onboarding", "common"]);
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>(1);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exitStage, setExitStage] = useState<ExitStage>("flow");
  const [activeInsightKey, setActiveInsightKey] = useState<string | null>(null);
  const [insightStatus, setInsightStatus] = useState<ConnectorInsightStatus>("hidden");
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingInsightExitRef = useRef(false);
  const composio = useComposio();

  const clearWaitTimer = useCallback(() => {
    if (waitTimerRef.current) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearWaitTimer, [clearWaitTimer]);

  const finish = useCallback(async () => {
    setFinishing(true);
    setError(null);
    try {
      await onComplete();
      // On success App.tsx flips to the main shell — this component
      // unmounts before the next render so we don't clear local state.
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setFinishing(false);
    }
  }, [onComplete, t]);

  const handleInsightStatus = useCallback((status: ConnectorInsightStatus, insightKey: string | null) => {
    setInsightStatus(status);
    setActiveInsightKey(insightKey);
    if (status === "hidden") {
      const shouldFinish = awaitingInsightExitRef.current;
      awaitingInsightExitRef.current = false;
      clearWaitTimer();
      if (shouldFinish) {
        void finish();
      }
      return;
    }
    if (status === "ready" || status === "error") {
      if (awaitingInsightExitRef.current) {
        awaitingInsightExitRef.current = false;
        clearWaitTimer();
        setExitStage("summary");
        return;
      }
      setExitStage((current) => (current === "waiting" ? "summary" : current));
    }
  }, [clearWaitTimer, finish]);

  const continueFromInsight = useCallback(() => {
    void finish();
  }, [finish]);

  const finishOrShowInsight = useCallback(() => {
    setError(null);
    clearWaitTimer();
    if (!activeInsightKey || insightStatus === "hidden") {
      awaitingInsightExitRef.current = false;
      void finish();
      return;
    }

    if (insightStatus === "ready" || insightStatus === "error") {
      awaitingInsightExitRef.current = false;
      setExitStage("summary");
      return;
    }

    awaitingInsightExitRef.current = true;
    waitTimerRef.current = setTimeout(() => {
      setExitStage((current) => (current === "summary" ? current : "waiting"));
    }, INSIGHT_WAIT_GRACE_MS);
  }, [activeInsightKey, clearWaitTimer, finish, insightStatus]);

  const showInsightPage = exitStage === "summary";
  const showWaitingPage = exitStage === "waiting";

  return (
    <View style={styles.root}>
      {/* dev: animate-bg-flow opacity-60 + bg-white/30（native 下渐变静止）。 */}
      <FlowBackdrop veilOpacity={0.3} />
      <View
        style={[
          styles.column,
          { paddingTop: insets.top, maxWidth: showInsightPage ? 672 : 576 },
        ]}
      >
        <View style={styles.body}>
          <ConnectorOnboardingInsight
            connections={composio.connections}
            mode={showInsightPage ? "page" : "watcher"}
            onStatusChange={handleInsightStatus}
            onContinue={continueFromInsight}
            continueLabel={t("insightWait.continue")}
          />

          {showWaitingPage ? (
            <InsightWaitPage />
          ) : !showInsightPage && step === 1 ? (
            <>
              <StepHeader step={1} title={t("step3.title")} subtitle={t("step3.subtitleConnect")} />
              <ScrollView style={styles.stepScroll} showsVerticalScrollIndicator={false}>
                <DataConnections composio={composio} />
              </ScrollView>
            </>
          ) : !showInsightPage && step === 2 ? (
            <>
              <StepHeader step={2} title={t("step1.title")} subtitle={t("step1.subtitleNative")} />
              <ScrollView
                style={styles.stepScroll}
                contentContainerStyle={{ gap: 12 }}
                showsVerticalScrollIndicator={false}
              >
                <AmbientSourceControlsPanel userId={userId} />
                <VoiceIdentitySettings userId={userId} />
              </ScrollView>
            </>
          ) : !showInsightPage ? (
            <>
              <StepHeader step={3} title={t("step2.title")} subtitle={t("step2.subtitleNative")} />
              <ScrollView style={styles.stepScroll} showsVerticalScrollIndicator={false}>
                <AmbientModelSetupStep />
              </ScrollView>
            </>
          ) : null}
        </View>

        {!showInsightPage && !showWaitingPage ? (
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 24) }]}>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.footerRow}>
              {step < 3 ? (
                <>
                  <Pressable onPress={() => setStep((step + 1) as Step)} accessibilityRole="button">
                    {({ pressed }) => (
                      <View style={[styles.ghostButton, pressed && styles.ghostButtonPressed]}>
                        <Text style={styles.ghostButtonText}>{t("skip")}</Text>
                      </View>
                    )}
                  </Pressable>
                  <Pressable onPress={() => setStep((step + 1) as Step)} accessibilityRole="button">
                    {({ pressed }) => (
                      <View style={[styles.primaryButton, pressed && { opacity: 0.9 }]}>
                        <Text style={styles.primaryButtonText}>{t("next")}</Text>
                        <ChevronRight size={15} strokeWidth={2} color={BACKGROUND} />
                      </View>
                    )}
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable onPress={() => setStep(2)} disabled={finishing} accessibilityRole="button">
                    {({ pressed }) => (
                      <View
                        style={[
                          styles.ghostButton,
                          finishing && { opacity: 0.4 },
                          pressed && !finishing && styles.ghostButtonPressed,
                        ]}
                      >
                        <Text style={styles.ghostButtonText}>{t("back")}</Text>
                      </View>
                    )}
                  </Pressable>
                  <Pressable onPress={finishOrShowInsight} disabled={finishing} accessibilityRole="button">
                    {({ pressed }) => (
                      <View
                        style={[
                          styles.primaryButton,
                          finishing && { opacity: 0.5 },
                          pressed && !finishing && { opacity: 0.9 },
                        ]}
                      >
                        {finishing ? <Spin size={14} color={BACKGROUND} /> : null}
                        <Text style={styles.primaryButtonText}>{t("common:status.done")}</Text>
                      </View>
                    )}
                  </Pressable>
                </>
              )}
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  // dev: relative z-10 flex min-h-0 w-full flex-col px-5 pt-safe-top + max-w-xl/2xl 居中。
  column: { flex: 1, width: "100%", alignSelf: "center", paddingHorizontal: 20 },
  // dev: flex min-h-0 flex-1 flex-col pb-3 pt-6。
  body: { flex: 1, paddingTop: 24, paddingBottom: 12 },
  stepScroll: { flex: 1 },

  // ── StepHeader（dev 同名）──
  stepHeader: { marginBottom: 20 },
  stepMetaRow: { marginBottom: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  // dev: caption(11) semibold uppercase tracking-wider fg/40。
  stepOf: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.55,
    textTransform: "uppercase",
    color: fg(0.4),
  },
  progressTrack: { flex: 1, height: 4, borderRadius: 999, backgroundColor: fg(0.15), overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 999, backgroundColor: fg() },
  // dev: text-2xl(24/32) font-semibold tracking-tight。
  stepTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 24,
    lineHeight: 32,
    letterSpacing: -0.6,
    color: fg(),
  },
  // dev: bodySm(13) mt-1 leading-relaxed fg/55。
  stepSubtitle: { marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 21, color: fg(0.55) },

  // ── 底部按钮排 ──
  footer: { paddingTop: 12 },
  errorText: {
    marginBottom: 8,
    textAlign: "right",
    fontFamily: "Inter_400Regular",
    fontSize: 12, // label
    lineHeight: 16, // leading-snug
    color: "#ef4444",
  },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  // dev: min-h-11(44) rounded-full px-4 bodySm medium fg/55 + hover:bg-foreground/[0.06]。
  ghostButton: {
    minHeight: 44,
    borderRadius: 999,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostButtonPressed: { backgroundColor: fg(0.06) },
  ghostButtonText: { fontFamily: "Inter_500Medium", fontSize: 13, lineHeight: 19, color: fg(0.55) },
  // dev: min-h-11 rounded-full bg-foreground px-5 bodySm semibold text-background。
  primaryButton: {
    minHeight: 44,
    borderRadius: 999,
    backgroundColor: fg(),
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  primaryButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: BACKGROUND },

  // ── InsightWaitPage ──
  waitHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16 },
  waitHeaderIcon: {
    marginTop: 2,
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: emerald(0.08),
  },
  waitEyebrow: {
    marginBottom: 4,
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: fg(0.34),
  },
  waitHeading: {
    maxWidth: 288,
    fontFamily: "Inter_600SemiBold",
    fontSize: 24, // text-title
    lineHeight: 26, // leading-[1.08]
    letterSpacing: -0.6,
    color: fg(),
  },
  waitDescription: { marginTop: 12, maxWidth: 384, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20, color: fg(0.55) },
  waitBody: { flex: 1, paddingHorizontal: 20, paddingBottom: 20 },
  // dev: rounded-[24px] border fg/0.07 bg-white/45 p-4。
  waitBox: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: fg(0.07),
    backgroundColor: "rgba(255,255,255,0.45)",
    padding: 16,
  },
  waitBoxHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  waitBoxTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.32,
    textTransform: "uppercase",
    color: fg(0.42),
  },
  waitLivePill: {
    borderRadius: 999,
    backgroundColor: fg(0.055),
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    lineHeight: 10,
    color: fg(0.45),
    overflow: "hidden",
  },
  waitProgressTrack: { marginTop: 16, height: 6, borderRadius: 999, backgroundColor: fg(0.06), overflow: "hidden" },
  waitProgressFill: { height: "100%", width: "66.667%", borderRadius: 999, backgroundColor: fg(0.7) },
  waitStepRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  waitStepIconBox: {
    width: 32,
    height: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: fg(0.045),
  },
  waitStepLabel: { fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 20, color: fg(0.76) },
  waitStepDetail: { marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.45) },
  waitStepSpinner: {
    marginTop: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: emerald(0.1),
  },
  waitFooter: {
    flexDirection: "row",
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: fg(0.06),
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  waitFooterText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: fg(0.48) },
});
