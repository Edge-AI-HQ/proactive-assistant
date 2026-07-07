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
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutAnimation,
  Linking,
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
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  X,
  Zap,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  basketToLovableCategory,
  isCompletedCardOutcome,
  isReminderCard,
  reasoningStepKey,
  reasoningStepLabel,
  sourceAppMeta,
  type DangerousAction,
  type ExecuteArtifact,
  type ReasoningStep,
  type RunSnapshot,
  type SideEffect,
  type SSEEvent,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardExecutionRun } from "@pin-ai/state";

import { useOptionalCardActions } from "../app/CardActionsProvider";
import { useSinkDismissGesture } from "../chat/useSinkDismiss";
import { CATEGORIES } from "./SphereCards";
import i18n from "../../i18n";
import { sourceIcon } from "../../lib/source-icons";
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
    rows.push({
      text: preview && preview.length <= 140 ? preview : i18n.t("card:fallback.calledTool", { name }),
      tool: name,
    });
  }
  return rows;
}

/** web summaryToFallbackArtifact：agent 纯文本收尾（没调 propose_action）时，把
 *  result.summary 包成一条 "Agent's note" 草稿，抽屉才有东西可读。 */
function summaryToFallbackArtifact(summary: string | undefined): ExecuteArtifact[] {
  const text = (summary ?? "").trim();
  if (!text) return [];
  return [{ kind: "other", title: i18n.t("card:fallback.agentNote"), body: text }];
}

/* ── Generated drafts 的展示映射（web chat-card-presentation 同源，dev 硬编码英文）──
 * web 先把 ExecuteArtifact 投成 lovable Artifact（email_draft→email/gmail、
 * message→slack、doc→gdocs、other→notes）再取 label/verb；RN 直接按
 * ExecuteArtifact.kind 查同一组结果，省一层投影。 */
const ARTIFACT_KIND_LABEL: Record<ExecuteArtifact["kind"], string> = {
  email_draft: "Email draft",
  message: "Message draft",
  doc: "Document",
  other: "Notes",
};

/** web SIDE_EFFECT_VERB（按 app：gmail→Sent / slack→Posted / gdocs→Created）。 */
const SIDE_EFFECT_VERB: Record<ExecuteArtifact["kind"], string> = {
  email_draft: "Sent",
  message: "Posted",
  doc: "Created",
  other: "",
};

const ARTIFACT_ICON = {
  email_draft: Mail,
  message: MessageSquare,
  doc: FileText,
  other: FileText,
} as const;

/** web matchSideEffect：artifact.kind → side_effect.slug 前缀启发式匹配，
 *  草稿 label 升级 "Email draft" → "Email draft · Sent"。 */
function matchSideEffect(
  artifact: ExecuteArtifact,
  sideEffects: SideEffect[],
): SideEffect | null {
  if (artifact.kind === "email_draft") {
    return sideEffects.find((s) => s.slug.startsWith("GMAIL_")) ?? null;
  }
  if (artifact.kind === "message") {
    return sideEffects.find((s) => s.slug.startsWith("SLACK_")) ?? null;
  }
  if (artifact.kind === "doc") {
    return (
      sideEffects.find(
        (s) =>
          s.slug.startsWith("NOTION_") ||
          s.slug.startsWith("GDOCS_") ||
          s.slug.startsWith("GDRIVE_"),
      ) ?? null
    );
  }
  return null;
}

/** web executeArtifactToLovable 的 meta 提取：a.meta.meta 为 string 才用。 */
function artifactMeta(a: ExecuteArtifact): string | undefined {
  return typeof a.meta === "object" && a.meta && typeof (a.meta as Record<string, unknown>).meta === "string"
    ? String((a.meta as Record<string, unknown>).meta)
    : undefined;
}

/** web urlFromMeta：从 opaque output_meta 里挑第一个 url/permalink/web_link。 */
function urlFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["url", "permalink", "web_link"] as const) {
    const v = m[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
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
  const { t } = useTranslation("card");
  const Icon = sourceIcon(slug);
  // 对齐 web sourceAppDisplay：普通词走 i18n（card:sourceApp.*），品牌词
  // （无 labelKey）保留英文 brand 名。
  const meta = sourceAppMeta(slug);
  const label = meta.labelKey ? t(`sourceApp.${meta.labelKey}`) : meta.label;
  return (
    <View style={styles.pill}>
      <View style={styles.pillIcon}>
        <Icon size={12} color="rgba(29,33,48,0.7)" strokeWidth={1.8} />
      </View>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  );
}

/** HOW I REASONED——web HowGeneratedSection：默认折叠，点开展开 reasoning steps。 */
function HowReasoned({ steps }: { steps: ReasoningStep[] }) {
  const { t } = useTranslation("card");
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
          <Text style={styles.sectionLabelMuted}>{t("detail.howReasoned").toUpperCase()}</Text>
          <Text style={styles.stepCount}>· {t("detail.stepCount", { count: steps.length })}</Text>
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
                <Text style={styles.stepLabel}>
                  {(() => {
                    // 对齐 web HowGeneratedSection：已知枚举走 i18n，未知回落英文 prettify。
                    const key = reasoningStepKey(s.label);
                    return (key ? t(`reasoningStep.${key}`) : reasoningStepLabel(s.label)).toUpperCase();
                  })()}
                </Text>
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
function ExecutionPlan({ steps }: { steps: { text: string; tool: string }[] }) {
  const { t } = useTranslation("card");
  const [open, setOpen] = useState(true);
  if (steps.length === 0) return null;
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
          <GradientLabel text={t("detail.executionPlan").toUpperCase()} />
          <Text style={styles.stepCount}>· {t("detail.stepCount", { count: steps.length })}</Text>
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

/** Status banner——web renderStatusBanner：仅非 needs_input（无 live approval
 *  payload）时渲染 preparing/resuming/done 结果摘要/error/cancelled，让用户
 *  理解按钮为什么和之前形态不一致。 */
function StatusBanner({
  snapshot,
  hasLiveApproval,
}: {
  snapshot: RunSnapshot | null;
  hasLiveApproval: boolean;
}) {
  const { t } = useTranslation("card");
  if (!snapshot) return null;
  if (hasLiveApproval) return null;
  switch (snapshot.status) {
    case "running":
    case "resuming":
      return (
        <View style={styles.bannerNeutral}>
          <Spin>
            <Loader2 size={13} color={`rgba(${FG},0.55)`} />
          </Spin>
          <Text style={styles.bannerNeutralText}>
            {snapshot.status === "running" ? t("statusBanner.preparing") : t("statusBanner.resuming")}
          </Text>
        </View>
      );
    case "done":
      return (
        <View style={styles.bannerDone}>
          <LinearGradient
            colors={[`rgba(${PRIMARY},0.08)`, `rgba(${PRIMARY},0.03)`]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.bannerDoneLabel}>
            <GradientLabel text={t("statusBanner.resultTitle").toUpperCase()} />
          </View>
          <Text style={styles.bannerDoneBody}>
            {snapshot.result?.summary || t("statusBanner.resultFallback")}
          </Text>
        </View>
      );
    case "error":
      return (
        <View style={styles.bannerError}>
          <Text style={styles.bannerErrorLabel}>{t("statusBanner.failedTitle").toUpperCase()}</Text>
          <Text style={styles.bannerErrorBody}>
            {snapshot.errorMessage || t("statusBanner.failedFallback")}
          </Text>
        </View>
      );
    case "cancelled":
      return (
        <View style={styles.bannerCancelled}>
          <Text style={styles.bannerCancelledText}>{t("statusBanner.cancelled")}</Text>
        </View>
      );
    default:
      return null;
  }
}

/** 单条草稿——web ArtifactItem：可展开（首条默认开），label 随 side_effect
 *  升级（"Email draft" → "Email draft · Sent"，失败 → "· Failed"），展开体
 *  保留换行；side_effect 带 url 时给 "Open ↗"。real 卡永无 locked
 *  （realCardToLovableIntent 不产 locked），Pro 模糊态不搬。 */
function ArtifactRow({
  artifact,
  index,
  sideEffect,
}: {
  artifact: ExecuteArtifact;
  index: number;
  sideEffect: SideEffect | null;
}) {
  const [expanded, setExpanded] = useState(index === 0);
  const Icon = ARTIFACT_ICON[artifact.kind] ?? FileText;
  const meta = artifactMeta(artifact);
  const url = sideEffect && !sideEffect.is_error ? urlFromMeta(sideEffect.output_meta) : null;
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setExpanded((v) => !v);
  };
  return (
    <View style={styles.artifact}>
      <Pressable onPress={toggle} style={styles.artifactHeader} accessibilityRole="button">
        <View style={styles.artifactIconBox}>
          <Icon size={14} color={`rgba(${FG},0.75)`} strokeWidth={1.8} />
        </View>
        <View style={styles.flex1}>
          {/* label 升级三态（web ArtifactItem 同构）：无 side_effect → 灰；
              失败 → 红 "· Failed"；成功 → 绿 "· Sent/Posted/Created"。 */}
          {!sideEffect ? (
            <Text style={styles.artifactKind}>{ARTIFACT_KIND_LABEL[artifact.kind].toUpperCase()}</Text>
          ) : sideEffect.is_error ? (
            <Text style={[styles.artifactKind, styles.artifactKindFailed]}>
              {`${ARTIFACT_KIND_LABEL[artifact.kind]} · Failed`.toUpperCase()}
            </Text>
          ) : (
            <Text style={[styles.artifactKind, styles.artifactKindSent]}>
              {`${ARTIFACT_KIND_LABEL[artifact.kind]} · ${SIDE_EFFECT_VERB[artifact.kind]}`.toUpperCase()}
            </Text>
          )}
          <Text style={styles.artifactTitle} numberOfLines={1}>
            {artifact.title}
          </Text>
          {meta ? (
            <Text style={styles.artifactMeta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        <ChevronUp
          size={14}
          color={`rgba(${FG},0.35)`}
          strokeWidth={2}
          style={{ transform: [{ rotate: expanded ? "0deg" : "180deg" }] }}
        />
      </Pressable>
      {expanded ? (
        <View style={styles.artifactBody}>
          <Text style={styles.artifactBodyText}>{artifact.body}</Text>
          {url ? (
            <Pressable onPress={() => void Linking.openURL(url)} hitSlop={6} accessibilityRole="link">
              <Text style={styles.artifactOpenLink}>Open ↗</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Generated drafts——web DrawerDetailBody 白底可折叠区（默认展开）。 */
function GeneratedDrafts({
  artifacts,
  sideEffects,
}: {
  artifacts: ExecuteArtifact[];
  sideEffects: SideEffect[];
}) {
  const { t } = useTranslation("card");
  const [open, setOpen] = useState(true);
  if (artifacts.length === 0) return null;
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(220, "easeInEaseOut", "opacity"));
    setOpen((v) => !v);
  };
  return (
    <View style={styles.draftsBox}>
      <Pressable onPress={toggle} style={styles.collapHeader} accessibilityRole="button">
        <View style={styles.rowCenter}>
          <FileText size={13} color={`rgba(${FG},0.6)`} strokeWidth={2.5} />
          <Text style={styles.draftsLabel}>
            {t("detail.generatedDrafts", { count: artifacts.length }).toUpperCase()}
          </Text>
          <Text style={styles.stepCount}>· {artifacts.length}</Text>
        </View>
        <ChevronDown
          size={16}
          color={`rgba(${FG},0.4)`}
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {open ? (
        <View style={styles.draftsBody}>
          {artifacts.map((a, i) => (
            <ArtifactRow key={i} artifact={a} index={i} sideEffect={matchSideEffect(a, sideEffects)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Dangerous actions——web DrawerDetailBody 琥珀可折叠区（默认展开），仅当
 *  最新 send_message payload 带 dangerous_actions 时出现。 */
function DangerousActions({ actions }: { actions: DangerousAction[] }) {
  const { t } = useTranslation("card");
  const [open, setOpen] = useState(true);
  if (actions.length === 0) return null;
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setOpen((v) => !v);
  };
  return (
    <View style={styles.dangerBox}>
      <Pressable onPress={toggle} style={styles.collapHeader} accessibilityRole="button">
        <View style={styles.rowCenter}>
          <AlertTriangle size={13} color="#d97706" strokeWidth={2.5} />
          <Text style={styles.dangerLabel}>{t("detail.approvingTitle").toUpperCase()}</Text>
          <Text style={styles.stepCount}>· {actions.length}</Text>
        </View>
        <ChevronDown
          size={16}
          color="rgba(217,119,6,0.7)"
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {open ? (
        <View style={styles.dangerBody}>
          {actions.map((a, i) => (
            <View key={`${a.slug}-${i}`} style={styles.dangerRow}>
              <View style={styles.dangerIconBox}>
                <AlertTriangle size={13} color="#d97706" strokeWidth={1.8} />
              </View>
              <View style={styles.execText}>
                <Text style={styles.dangerRiskLabel}>{a.risk_label}</Text>
                <Text style={styles.execStepTool}>{a.slug.toUpperCase()}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Risks——web DrawerDetailBody 的普通 bullet 区（agent plan 一句话风险）。 */
function Risks({ risks }: { risks: string[] }) {
  const { t } = useTranslation("card");
  if (risks.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t("detail.risksTitle").toUpperCase()}</Text>
      <View style={styles.riskList}>
        {risks.map((r, i) => (
          <View key={i} style={styles.riskRow}>
            <View style={styles.riskDot} />
            <Text style={styles.riskText}>{r}</Text>
          </View>
        ))}
      </View>
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
  const { t } = useTranslation(["card", "common"]);
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 壳级单实例动作集合（可选：CardChatScreen 的挂载点可能在 Provider 外）。
  // completed/pending 视图态从这里拿（web AppLayout 给 CardDrawer 传
  // doneIds/processingIds 派生 prop 的同构）。
  const cardActions = useOptionalCardActions();
  const open = entry !== null;
  const [mounted, setMounted] = useState(open);
  const y = useSharedValue(height);
  // 面板实测高度（onLayout 填），退场动画滑出距离 = 面板自身高度、不是整屏 height。
  // 这是「下拉秒退场」的真凶：面板底部锚定、只有 maxHeight 0.92 屏高，短卡片时把 y 一路
  // 动到整屏 height + ease-out 前重 → 面板在头 ~50ms 就滑出可视区，剩下 270ms 在屏外空跑
  // = 看着像瞬间消失。动到 panelH 后，整段 320ms 都在可视区内滑，才丝滑。fallback=height。
  const panelH = useSharedValue(height);
  // 退场存活门（同 CardChatScreen 的 lastTarget 范式）：entry 置空后退场动画还要再
  // 渲染若干帧，否则 `if (!card || !shown) return null` 会在动画播放前就卸载 = 「秒退场」。
  // 渲染一律用 shown（= 最后一次非空 entry），下滑动画播完（setMounted(false)）才真正卸载。
  const lastEntry = useRef<VisibleCardEntry | null>(null);
  if (entry) lastEntry.current = entry;
  const shown = entry ?? lastEntry.current;

  // Part B：card 执行 run（web useCardExecutionRun）——拿 lastMessagePayload.plan
  // 渲染 EXECUTION PLAN。runId=null（抽屉关）时 hook no-op；本地历史源同主 chat。
  // 声明提前到进场 effect 之前：进场要用 run.loading 做「内容就位」门（见下）。
  const run = useCardExecutionRun(shown?.card?.id ?? null, { localHistory: readLocalHistory });

  // 「内容就位」门——修「打开时两段式展开闪一下」：EXECUTION PLAN / drafts / status
  // banner 由 run 异步填充（本地有记录毫秒级、无记录要等网络页）。若面板先带着"矮版"
  // 内容起浮、数据中途到达，这几段以默认展开态整段挂载，底部锚定的面板顶边被猛地顶高
  // = 两段式。所以等 run 就位再起浮，面板带完整内容一次浮出（浮出速度不变）。
  // 350ms 兜底：网络太慢就不再等——宁可偶发长高，不能让点击像没反应。
  const [slowOpen, setSlowOpen] = useState(false);
  useEffect(() => {
    setSlowOpen(false);
    if (!open || !run.loading) return;
    const t = setTimeout(() => setSlowOpen(true), 350);
    return () => clearTimeout(t);
  }, [open, run.loading, shown?.card?.id]);
  const contentReady = !run.loading || slowOpen;

  // deps 含 shown.card.id：退场动画途中（open 恒为 true）若换开另一张卡（entry A→B），
  // 光靠 open 布尔不变 → 开场 spring 不会重跑 → 新卡跟着旧退场滑出屏、被吞掉。带上卡片
  // 身份后，A→B 会重跑本 effect 的 open 分支 spring(0) 把新卡弹回来（并取消上一条 withTiming
  // 的完成回调：动画被替换 → finished=false → 那句 onClose 不触发，新卡不会误关）。
  useEffect(() => {
    if (open) {
      setMounted(true);
      if (!contentReady) {
        // 数据未就位：面板钉在整屏外等待（防上一张卡的 panelH 残值 < 本卡初始高度时
        // 顶边露头）。contentReady 翻 true 会重跑本 effect 走下面的 spring。
        y.value = height;
        return;
      }
      y.value = withSpring(0, { stiffness: 320, damping: 32, mass: 0.9, overshootClamping: true });
    } else {
      y.value = withTiming(panelH.value, { duration: 320, easing: Easing.out(Easing.cubic) }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
  }, [open, shown?.card?.id, contentReady, height, panelH, y]);

  const dragDown = Gesture.Pan()
    .activeOffsetY(12)
    .onUpdate((e) => {
      y.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > height * 0.18 || e.velocityY > 600) {
        // 过阈值 → 在 worklet 里从松手位置续着滑出屏外（跟手连续、无 JS 往返卡顿）。
        // 滑到 panelH（面板自身高度）而非整屏 height：短卡片才不会头 50ms 就没影 =「秒退场」。
        // 动画播完才 onClose（→ entry 置空 → 面板此时已在屏外，卸载不可见）。
        y.value = withTiming(panelH.value, { duration: 320, easing: Easing.out(Easing.cubic) }, (done) => {
          if (done) runOnJS(onClose)();
        });
      } else {
        y.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
      }
    });

  // 右滑退出：改用 chat 同款「左缘窄条」模型（= dev）——只在面板最左 24px 起拖右滑 → 跟手
  // 下沉退出。不再整幅 swipe-anywhere（那会和内层 ScrollView 竖滚抢手势 = 之前「右滑不顺手」
  // 的根因）。下拉退出仍是整幅 dragDown（主手势），右滑只作边缘辅助（挂在下方 edgeZone）。
  const edgeSink = useSinkDismissGesture(y, height, width, onClose, { activateX: 10, failY: 12 });

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, y.value / panelH.value) }));

  if (!mounted) return null;
  const card = shown?.card;
  if (!card || !shown) return null;

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

  // completed 视图（web CardDrawerContent:50）：本地 doneIds / 服务端 complete
  // outcome / run 已 done，三者任一即收敛成单 Close 按钮。
  const completed =
    (cardActions?.doneIds.has(card.id) ?? false) || isCompletedCardOutcome(shown.latestOutcome);
  const showCompletedView = completed || run.snapshot?.status === "done";
  // pending（web CardDrawer pending prop = processingIds）：动作按钮禁用 +
  // Approve 显 "Opening..."。
  const pending = cardActions?.processingIds.has(card.id) ?? false;

  // 数据源优先级（web DrawerDetailBody 同注释）：① cached lastMessagePayload
  // （audit 字段跨 propose_action 向前合并）② 静态 card.detail——real 卡恒空
  // （realCardToLovableIntent 只产 executionPlan:[]，RN 直接跳过）③ 派生兜底
  // （text-only 收尾 → summary 包成 Agent's note；tool-call 事件压成 plan）。
  // completed 视图下 cached 置 null（web CardDrawerContent:94），让 done banner
  // + 兜底摘要接管。dangerous_actions / risks 无兜底，只吃 cached。
  const cached = showCompletedView ? null : run.lastMessagePayload;
  const cachedPlan = (cached?.plan ?? []).map((s) => ({
    text: s.summary,
    tool: s.slug || s.tool,
  }));
  const planSteps = cachedPlan.length > 0 ? cachedPlan : eventsToFallbackPlan(run.events);
  const cachedArtifacts = cached?.drafts ?? [];
  const summaryArtifacts = summaryToFallbackArtifact(run.snapshot?.result?.summary);
  const artifacts = cachedArtifacts.length > 0 ? cachedArtifacts : summaryArtifacts;
  const dangerousActions = cached?.dangerous_actions ?? [];
  const risks = cached?.risks ?? [];
  const sideEffects = run.snapshot?.result?.side_effects ?? [];

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { bottom: -insets.bottom }, dimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <BlurView intensity={10} tint="light" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.dimTint]} />
        </Pressable>
      </Animated.View>

      <Animated.View
        onLayout={(e) => {
          // 实测面板高度 → 退场滑出距离用它（见 panelH 注释）。忽略 0（初次布局前）。
          const h = e.nativeEvent.layout.height;
          if (h > 0) panelH.value = h;
        }}
        style={[styles.panelWrap, { maxHeight: height * 0.92, bottom: -insets.bottom }, panelStyle]}
      >
        {/* 整幅下拉退出（web vaul 下拉）：dragDown 包住面板。右滑退出改挂左缘窄条（见下方 edgeSink）。 */}
        <GestureDetector gesture={dragDown}>
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
              <Text style={styles.catLabel}>{t(cat.labelKey).toUpperCase()}</Text>
              {isUrgent ? (
                <View style={styles.urgentPill}>
                  <Text style={styles.urgentText}>{t("tag.urgent")}</Text>
                </View>
              ) : null}
            </View>

            {/* 标题（web text-display text-subheading 17/600/-0.02em） */}
            <Text style={styles.title}>{card.title}</Text>

            {/* 简略行 */}
            {brief ? <Text style={styles.brief}>{brief}</Text> : null}

            {/* Status banner（web renderStatusBanner）：preparing/resuming/
                done 结果摘要/error/cancelled。有 live approval payload 时让位。 */}
            <StatusBanner snapshot={run.snapshot} hasLiveApproval={!!cached} />

            {/* WHY NOW（绿框） */}
            {showWhyNow ? (
              <View style={styles.whyNowBox}>
                <Text style={styles.whyNowLabel}>{t("detail.whyNow").toUpperCase()}</Text>
                <Text style={styles.whyNowBody}>{card.whyNow}</Text>
              </View>
            ) : null}

            {/* EXECUTION PLAN（实时 run plan + events 兜底） */}
            <ExecutionPlan steps={planSteps} />

            {/* Generated drafts（cached.drafts → result.summary 兜底），label
                随 side_effects 升级 "· Sent" */}
            <GeneratedDrafts artifacts={artifacts} sideEffects={sideEffects} />

            {/* Dangerous actions（仅 cached payload 提供时） */}
            <DangerousActions actions={dangerousActions} />

            {/* Risks（一句话 bullet） */}
            <Risks risks={risks} />

            {/* SOURCES */}
            {sources.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>{t("detail.sourcesTitle").toUpperCase()}</Text>
                <View style={styles.sourceWrap}>
                  {sources.map((s) => (
                    <SourcePill key={s} slug={s} />
                  ))}
                </View>
              </View>
            ) : null}

            {/* HOW I REASONED（可折叠） */}
            <HowReasoned steps={steps} />

            {/* 动作行（web CardDrawerContent:100-156）：completed 视图收敛成单
                Close；否则 Dismiss / Done / Approve（reminder → Chat），pending
                时禁用 + Approve 显 "Opening..."。 */}
            {showCompletedView ? (
              <View style={styles.actions}>
                <Pressable
                  onPress={onClose}
                  style={[styles.btnSecondary, styles.btnGrow]}
                  accessibilityRole="button"
                  accessibilityLabel={t("common:status.close")}
                >
                  <Text style={styles.btnSecondaryText}>{t("common:status.close")}</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.actions}>
                <Pressable
                  onPress={() => onDismiss(shown)}
                  disabled={pending}
                  style={[styles.btnSecondary, pending ? styles.btnDisabledSecondary : null]}
                  accessibilityRole="button"
                  accessibilityLabel={t("drawer.dismiss")}
                >
                  <X size={13} color="rgba(29,33,48,0.55)" strokeWidth={2} />
                  <Text style={styles.btnSecondaryText}>{t("drawer.dismiss")}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onComplete(shown)}
                  disabled={pending}
                  style={[styles.btnDone, pending ? styles.btnDisabledSecondary : null]}
                  accessibilityRole="button"
                  accessibilityLabel={t("common:status.done")}
                >
                  <Check size={12} color="rgba(29,33,48,0.55)" strokeWidth={2.5} />
                  <Text style={styles.btnDoneText}>{t("common:status.done")}</Text>
                </Pressable>
                <Pressable
                  onPress={() => (reminder ? onChat(shown) : onApprove(shown))}
                  disabled={pending}
                  style={[styles.btnPrimary, pending ? styles.btnDisabledPrimary : null]}
                  accessibilityRole="button"
                  accessibilityLabel={reminder ? t("drawer.chat") : t("drawer.approve")}
                >
                  {pending && !reminder ? (
                    <>
                      <Spin>
                        <Loader2 size={13} color="#fff" />
                      </Spin>
                      <Text style={styles.btnPrimaryText}>{t("drawer.opening")}</Text>
                    </>
                  ) : reminder ? (
                    <>
                      <MessageCircle size={13} color="#fff" strokeWidth={2} />
                      <Text style={styles.btnPrimaryText}>{t("drawer.chat")}</Text>
                    </>
                  ) : (
                    <>
                      <Check size={13} color="#fff" strokeWidth={2.5} />
                      <Text style={styles.btnPrimaryText}>{t("drawer.approve")}</Text>
                    </>
                  )}
                </Pressable>
              </View>
            )}
          </ScrollView>
        </View>
        </GestureDetector>
        {/* 左缘退出条（dev 模型）：只最左 24px 起拖右滑 → 下沉退出;盖在面板上、纯 tap 不激活
            → 落到下层内容/按钮。handle 居中(不在此 24px 内),整幅下拉不受影响。 */}
        <GestureDetector gesture={edgeSink}>
          <View style={styles.edgeZone} accessibilityElementsHidden />
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
  // 左缘退出条（dev w-6=24px）：绝对定位、盖满面板高、只最左 24px。
  edgeZone: { position: "absolute", left: 0, top: 0, bottom: 0, width: 24 },
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

  // Status banner（web renderStatusBanner 四态）
  bannerNeutral: { marginBottom: 12, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: `rgba(${FG},0.1)`, backgroundColor: "rgba(255,255,255,0.55)" },
  bannerNeutralText: { flex: 1, fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.7)` },
  bannerDone: { marginBottom: 12, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: `rgba(${PRIMARY},0.2)`, overflow: "hidden" },
  bannerDoneLabel: { marginBottom: 4, alignSelf: "flex-start" },
  bannerDoneBody: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.8)`, lineHeight: 20 },
  bannerError: { marginBottom: 12, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", backgroundColor: "rgba(239,68,68,0.04)" },
  bannerErrorLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: "#dc2626", marginBottom: 4 },
  bannerErrorBody: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.75)`, lineHeight: 18 },
  bannerCancelled: { marginBottom: 12, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: `rgba(${FG},0.1)`, backgroundColor: `rgba(${FG},0.03)` },
  bannerCancelledText: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.6)`, lineHeight: 18 },

  // Generated drafts（web 白底可折叠区 + ArtifactItem）
  draftsBox: { marginBottom: 12, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: `rgba(${FG},0.1)`, backgroundColor: "rgba(255,255,255,0.55)" },
  draftsLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: `rgba(${FG},0.6)` },
  draftsBody: { paddingHorizontal: 12, paddingBottom: 12, paddingTop: 2, gap: 8 },
  artifact: { borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: `rgba(${FG},0.08)`, backgroundColor: "rgba(255,255,255,0.65)" },
  artifactHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  artifactIconBox: { width: 28, height: 28, borderRadius: 8, backgroundColor: "#fff", borderWidth: 1, borderColor: `rgba(${FG},0.1)`, alignItems: "center", justifyContent: "center" },
  artifactKind: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, color: `rgba(${FG},0.4)`, marginBottom: 2 },
  artifactKindSent: { color: "#15803d" },
  artifactKindFailed: { color: "#dc2626" },
  artifactTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: `rgba(${FG},0.85)`, lineHeight: 16 },
  artifactMeta: { fontSize: 11, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.45)`, marginTop: 2 },
  artifactBody: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, borderTopWidth: 1, borderTopColor: `rgba(${FG},0.06)` },
  artifactBodyText: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.75)`, lineHeight: 20 },
  artifactOpenLink: { marginTop: 8, fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.7)` },

  // Dangerous actions（web 琥珀区：amber-500/amber-600/amber-700）
  dangerBox: { marginBottom: 12, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: "rgba(245,158,11,0.22)", backgroundColor: "rgba(245,158,11,0.04)" },
  dangerLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.55, color: "#b45309" },
  dangerBody: { paddingHorizontal: 14, paddingBottom: 10 },
  dangerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 6 },
  dangerIconBox: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(245,158,11,0.08)", borderWidth: 1, borderColor: "rgba(245,158,11,0.3)" },
  dangerRiskLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.85)`, lineHeight: 18 },

  // Risks（bullet 列表）
  riskList: { gap: 4 },
  riskRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  riskDot: { marginTop: 7, width: 4, height: 4, borderRadius: 2, backgroundColor: `rgba(${FG},0.4)` },
  riskText: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.65)`, lineHeight: 18 },

  // 动作
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20 },
  btnSecondary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: `rgba(${FG},0.05)` },
  btnSecondaryText: { fontSize: 13, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.55)` },
  btnDone: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: `rgba(${FG},0.05)` },
  btnDoneText: { fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.55)` },
  btnPrimary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: "#1d2130" },
  btnPrimaryText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#fff" },
  // completed 视图单 Close 撑满一行（web flex-1）；pending 禁用透明度对齐 web
  // disabled:opacity-45（secondary）/ disabled:opacity-70（primary）。
  btnGrow: { flex: 1 },
  btnDisabledSecondary: { opacity: 0.45 },
  btnDisabledPrimary: { opacity: 0.7 },
});
