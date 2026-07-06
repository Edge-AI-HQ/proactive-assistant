/**
 * AMBIENT 页——web AmbientView 的 RN 对应物：
 * 页头 → hero 开关卡（接 useAmbientToggle，与 NOW 页开关同步）→ 设备条 →
 * 叙事摘要卡（TODAY · LOCAL SUMMARY）→ TODAY 时间线（图标格 + 时间·来源 + 隐私/置信徽章 +
 * tag + dismiss + load-more）→ 底部 hint。
 *
 * 时间线数据源 = 本地 SqliteTimelineStore（= dev on-device 架构）。runtime 的 ctx.push 已把
 * 采集信号写进 store，useAmbientTimeline 读回三路合成 TimelineEntry（对齐 dev）：LLM 摘要
 * 事件（缺 llama 时为空）+ latestRawEvents（每源最新一条）+ pendingTranscriptWindows（待转写
 * 窗口）。三路都空才显示 dev 同款空卡「No local timeline events yet」。LLM 摘要卡待端侧 llama。
 * 延后：triggered-card「Open→」handoff。
 */
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import {
  Activity,
  ChevronRight,
  Laptop,
  Lightbulb,
  Lock,
  Plus,
  Radio,
  Smartphone,
  Sparkles,
  Unlock,
  Watch,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { type IntentCard, type UserDevice, type UserDevicePlatform } from "@pin-ai/core";
import { useUserDevices } from "@pin-ai/state";

import i18n from "../i18n";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount } from "../lib/heat-probe";
import { GlassCard } from "../ui/GlassCard";
import PageHeader from "../components/app/PageHeader";
import { usePageActive } from "../components/app/KeepAlivePage";
import { useFullCover } from "../lib/full-cover";
import { useAmbientToggle } from "../hooks/useAmbientToggle";
import { useAmbientTimeline } from "../hooks/useAmbientTimeline";
import { useAmbientLiveSession } from "../hooks/useAmbientLiveSession";
import LiveSessionCard from "../components/ambient/LiveSessionCard";
import LiveFullscreen from "../components/ambient/LiveFullscreen";
import AmbientModelRequiredCard from "../components/ambient/AmbientModelRequiredCard";
import type { LiveSession } from "../ambient/live/live-session";
import {
  latestRawEventToEntry,
  pendingTranscriptWindowToEntry,
  timelineEventToEntry,
  type TimelineEntry,
} from "../ambient/timeline-entries";
import { isUploadsLocked, setUploadsLocked } from "../ambient/ingest";
import { ambientStatusSnapshot, subscribeAmbientStatus } from "../ambient/runtime";
import type { RuntimeStatus } from "../ambient/status";
import { EM_TIGHT, tracking } from "../ui/typography";

export interface HeaderProps {
  onOpenDebug: () => void;
  onOpenMenu: () => void;
}

// ── 设备条 helpers（对齐 dev AmbientView 的 iconForUserDevice / signalClassForUserDevice
//    / deviceStripSummary；文案照 dev 走 i18n（key 一致），色值沿用本文件 hex）──

/** 平台 → lucide 图标（wearable→Watch / sensor→Activity / embedded→Laptop / 其余→Smartphone）。 */
function iconForUserDevice(platform: UserDevicePlatform): LucideIcon {
  if (platform === "wearable") return Watch;
  if (platform === "sensor") return Activity;
  if (platform === "embedded") return Laptop;
  return Smartphone;
}

/** 信号点色：无 last_seen 或超 24h 未见 → amber-500，否则 emerald-500（dev signalClassForUserDevice）。 */
function signalColorForDevice(device: UserDevice): string {
  if (!device.last_seen_at) return "#f59e0b"; // amber-500
  const ageMs = Date.now() - new Date(device.last_seen_at).getTime();
  return ageMs > 24 * 60 * 60 * 1000 ? "#f59e0b" : "#10b981"; // amber-500 / emerald-500
}

/** 设备条汇总文案（dev deviceStripSummary，i18n key 与 dev 一致）。 */
function deviceStripSummary(
  count: number,
  loading: boolean,
  error: string | null,
  hidden: number,
): string {
  if (loading && count === 0) return i18n.t("ambient:view.deviceCountLoading");
  if (error && count === 0) return i18n.t("ambient:deviceStrip.unavailable");
  if (hidden > 0) return i18n.t("ambient:deviceStrip.moreConnected", { count: hidden });
  if (count > 0) return i18n.t("ambient:deviceStrip.manage");
  return i18n.t("ambient:deviceStrip.nonePaired");
}

// 时间线条目模型 + mapper（event/raw/pending → TimelineEntry）在 ambient/timeline-entries.ts。
const INITIAL_TIMELINE_COUNT = 10;
const TIMELINE_LOAD_MORE = 10;

// web 副标题各段共用：bodySm(13) Inter_400 + 显式 lineHeight（RN 必写）。
const subtitlePartStyle = { fontFamily: "Inter_400Regular", lineHeight: 18 };

// --foreground / --background 通道值。NativeWind 的 hsl(var(--x)) 没有 <alpha-value>
// 槽，/opacity 修饰符不可靠 → 带透明度的色一律内联 hsla()，保证渲染。
const FG = "230, 25%, 15%";
const fg = (alpha?: number) => (alpha === undefined ? `hsl(${FG})` : `hsla(${FG}, ${alpha})`);
const BG = "hsl(220, 30%, 96%)";
// dev 时间线 device 芯片 / 摘要标签用的品红（hsl(304 75% 45/55%)）。
const PINK = "hsl(304, 75%, 45%)";
const PINK_BRIGHT = "hsl(304, 75%, 55%)";

export default function AmbientScreen({
  headerProps,
  userId,
  onOpenConnect,
  onOpenChat,
  onOpenModelSetup,
}: {
  headerProps: HeaderProps;
  userId: string;
  onOpenConnect: () => void;
  /** Ambient→Action handoff（dev AppLayout.handleAmbientAction）：LLM 时间线
   *  事件的 "Open →" 把虚拟 IntentCard 送进 card chat。AppShell 传
   *  (card, bootstrap) => setCardChat({ card, bootstrap })（与 NowScreen 同款）。 */
  onOpenChat?: (card: IntentCard, bootstrap: string) => void;
  /** ModelRequiredCard 的 "Download" 引导：跳 Settings → Ambient 子页（模型
   *  面板在那里）。AppShell 传 () => navigate("setting")。 */
  onOpenModelSetup?: () => void;
}) {
  probeCount("render.AmbientScreen"); // __HEAT_PROBE__
  const { t } = useTranslation("ambient");
  const { ambientOn, togglePending, toggle } = useAmbientToggle(userId);
  const [locked, setLocked] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_TIMELINE_COUNT);
  // UI 可见性 = tab 可见（KeepAlivePage context）&& 未被全屏 sheet/debug 面板盖住
  // （审查 F3：从时间线打开 card chat 时 view 仍是 "ambient"，只看 pageActive 会在
  // 全屏 sheet 底下继续订阅+轮询）。下面的遥测订阅和 5s 本地轮询都按它门控。
  const pageActive = usePageActive();
  const covered = useFullCover();
  const uiActive = pageActive && !covered;
  // runtime 遥测订阅：hero 副标题显示第一个源错误（dev AmbientView:438-439,604-606）。
  // 只在可见时订阅——每个采集事件都 notify，隐藏时保持订阅 = 整棵隐藏树跟着空转
  // 重渲（2026-07-05 真机探针实测 264 次/11min，含锁屏期间）。切回时先取一次快照补齐。
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  useEffect(() => {
    if (!uiActive) return;
    const update = () => setRuntimeStatus(ambientStatusSnapshot());
    update();
    return subscribeAmbientStatus(update);
  }, [uiActive]);
  const firstSourceError =
    runtimeStatus?.sources.find((s) => s.lastError)?.lastError ?? null;
  const { devices, loading: devicesLoading, error: devicesError } = useUserDevices();
  // dev AmbientView：连接设备 = active 且非 web 平台（web 会话不算真实配对设备）。
  // header 计数与下方设备条同源，避免两处数字打架。
  const connectedDevices = devices.filter(
    (d) => d.status === "active" && d.platform !== "web",
  );
  const connectedCount = connectedDevices.length;
  const visibleConnectedDevices = connectedDevices.slice(0, 5);
  const hiddenDeviceCount = Math.max(0, connectedCount - visibleConnectedDevices.length);
  // dev view.deviceCountLabel：loading / error 回退 + 单复数化（i18n plural）。
  const deviceCountLabel =
    devicesLoading && connectedCount === 0
      ? t("view.deviceCountLoading")
      : devicesError && connectedCount === 0
        ? t("view.deviceCountUnavailable")
        : t("view.deviceCount", { count: connectedCount });

  // 时间线读本地 store（= dev on-device 架构）：三路合成 TimelineEntry + 时间倒序。
  // 5s 本地轮询按 pageActive 门控（省电/减热，WS8）；切回即时刷新。
  const {
    events,
    pendingTranscriptWindows,
    latestRawEvents,
    localDate,
    loading: timelineLoading,
    error: timelineError,
    storeStatus,
    narrativeSummary,
    dismiss,
  } = useAmbientTimeline(undefined, uiActive);
  const timelineEntries: TimelineEntry[] = [
    ...events.map((e) => timelineEventToEntry(e, dismiss)),
    ...pendingTranscriptWindows.map(pendingTranscriptWindowToEntry),
    ...latestRawEvents.map(latestRawEventToEntry),
  ].sort((a, b) => (b.sortTs ?? 0) - (a.sortTs ?? 0));
  // dev：LLM 事件(priority) 先显示,其余(raw/pending)按剩余槽位补。
  const priorityEntries = timelineEntries.filter((e) => e.priority);
  const otherEntries = timelineEntries.filter((e) => !e.priority);
  const visibleTimelineEntries = [
    ...priorityEntries,
    ...otherEntries.slice(0, Math.max(0, visibleCount - priorityEntries.length)),
  ];

  // 实时 live session（转写驱动）+ 全屏 focus overlay 目标（对齐 dev AmbientView）。
  const { session: liveSession, previewVisibleCount, dismiss: dismissLiveSession } =
    useAmbientLiveSession({ ambientOn, active: uiActive, dismissible: true });
  const [fullscreenSession, setFullscreenSession] = useState<LiveSession | null>(null);

  /** Ambient Action handoff（dev AppLayout.handleAmbientAction:633-670 逐字）：
   *  把 AmbientTimelineEntry 包成虚拟 IntentCard，交给现有 card-chat 运行时
   *  （sessionKey 落到 card-thread-ambient-<entry.id>，服务端零改动）。 */
  const handleAmbientAction = (entry: TimelineEntry) => {
    if (!entry.action || !onOpenChat) return;
    const entryId = entry.id ?? `${entry.time}-${entry.title}`.replace(/\s+/g, "-").toLowerCase();
    const ambientCardId = `ambient-${entryId}`;
    const virtualCard: IntentCard = {
      id: ambientCardId,
      goalBasket: entry.action.goalBasket ?? "life",
      title: entry.title,
      whyNow: `Ambient event captured at ${entry.time} on ${entry.device.name}.`,
      summary: entry.body,
      primaryAction: { label: entry.action.label, type: "confirm" },
      secondaryActions: [],
      confidence: entry.confidenceLabel === "uncertain" ? 0.5 : 0.85,
      urgency: 0.5,
      importance: 0.6,
      sources: [entry.device.name, ...entry.tags],
      sourceApps: [],
      reasoningSteps: [],
      agentChain: ["ambient"],
      createdAt: new Date().toISOString(),
    };
    const bootstrap = [
      "The user clicked an action from an Ambient Timeline event.",
      "",
      "Event:",
      entry.title,
      entry.body,
      "",
      "Action:",
      entry.action.label,
      "",
      "Goal:",
      entry.action.goal,
    ].join("\n");
    onOpenChat(virtualCard, bootstrap);
  };

  // 跨天 → 重置 load-more（对齐 dev localDate 重置）。
  useEffect(() => {
    setVisibleCount(INITIAL_TIMELINE_COUNT);
  }, [localDate]);

  // upload soft-lock：开时显示锁钮；锁上 = 暂停上传（继续本地采集）。持久化在 ingest。
  useEffect(() => {
    void isUploadsLocked().then(setLocked);
  }, []);
  const toggleLock = async () => {
    const next = !locked;
    setLocked(next);
    await setUploadsLocked(next);
  };

  return (
    <View className="flex-1">
      <PageHeader
        title={
          // web AmbientView h1：text-2xl(24) / font-semibold(600) / tracking-tight(-0.025em) / leading-tight(1.25→30)。
          <Text
            className="text-[24px] text-foreground"
            style={{ fontFamily: "Inter_600SemiBold", letterSpacing: tracking(24, EM_TIGHT), lineHeight: 28 }}
          >
            {t("view.title")}
          </Text>
        }
        subtitle={
          // web 副标题：bodySm(13) / foreground-60，中点 "·" foreground-30，段间 gap-1.5(6)。
          <View className="mt-1 flex-row items-center" style={{ gap: 6 }}>
            <Text className="text-[13px]" style={[subtitlePartStyle, { color: fg(0.6) }]}>
              {deviceCountLabel}
            </Text>
            <Text className="text-[13px]" style={[subtitlePartStyle, { color: fg(0.3) }]}>·</Text>
            <Text className="text-[13px]" style={[subtitlePartStyle, { color: fg(0.6) }]}>
              {t("view.onDeviceTee")}
            </Text>
          </View>
        }
        {...headerProps}
      />
      <ScrollView className="flex-1 px-4" contentContainerClassName="pb-12">
        {/* 开关卡（web AmbientView hero switch）：渐变玻璃 + 雷达图标 + 文案 + 锁 + 开关 */}
        <AmbientHeroCard on={ambientOn}>
          <View className="flex-1 flex-row items-center" style={{ gap: 12 }}>
            <AmbientStatusIcon on={ambientOn} />
            <View className="flex-1">
              <Text
                numberOfLines={1}
                className="text-[13px]"
                style={{ fontFamily: "Inter_600SemiBold", lineHeight: 16, color: fg() }}
              >
                {ambientOn ? t("view.ambientOn") : t("view.ambientOff")}
              </Text>
              <Text
                numberOfLines={1}
                className="mt-0.5 text-[11px]"
                style={{ fontFamily: "Inter_400Regular", lineHeight: 14, color: fg(0.55) }}
              >
                {!ambientOn
                  ? t("view.statusPaused")
                  : locked
                    ? t("view.statusUploadsPaused")
                    : firstSourceError
                      ? firstSourceError
                      : t("view.statusListening")}
              </Text>
            </View>
          </View>
          <View className="flex-row items-center" style={{ gap: 8 }}>
            {ambientOn ? <LockButton locked={locked} onPress={() => void toggleLock()} /> : null}
            <AmbientToggle on={ambientOn} pending={togglePending} onPress={() => void toggle()} />
          </View>
        </AmbientHeroCard>

        {/* Live session 卡（dev AmbientView：ambient 开且检测到实时会话时显示）*/}
        <LiveSessionCard
          session={liveSession}
          previewVisibleCount={previewVisibleCount}
          variant="ambient"
          onFocus={setFullscreenSession}
          onDismiss={dismissLiveSession}
        />

        {/* 设备条（web AmbientView "Devices strip"）：可点跳 Connect + 平台图标 +
            信号点（绿=近期活跃 / 黄=超 24h 或未见）+ 溢出气泡 +N + 动态汇总文案 */}
        <Pressable
          onPress={onOpenConnect}
          accessibilityRole="button"
          accessibilityLabel={t("view.manageConnectedDevices")}
          className="mt-5"
        >
          <GlassCard className="flex-row items-center" style={{ padding: 10, gap: 8 }}>
            {/* 设备 avatar 行（-space-x-1.5 = -6 重叠）*/}
            <View className="flex-1 flex-row items-center">
              {visibleConnectedDevices.map((device, i) => {
                const Icon = iconForUserDevice(device.platform);
                return (
                  <View
                    key={device.device_id}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: BG,
                      borderWidth: 1,
                      borderColor: fg(0.1),
                      marginLeft: i > 0 ? -6 : 0,
                    }}
                  >
                    <Icon size={13} strokeWidth={1.8} color={fg(0.8)} />
                    {/* 信号点：6px 实心 + 1px 背景色环（对齐 web w-1.5 ring-background）*/}
                    <View
                      style={{
                        position: "absolute",
                        bottom: -2,
                        right: -2,
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: signalColorForDevice(device),
                        borderWidth: 1,
                        borderColor: BG,
                      }}
                    />
                  </View>
                );
              })}
              {/* 溢出/添加气泡（虚线圈；hidden>0 显 +N，否则 Plus）*/}
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: fg(0.05),
                  borderWidth: 1,
                  borderColor: fg(0.25),
                  borderStyle: "dashed",
                  marginLeft: visibleConnectedDevices.length > 0 ? -6 : 0,
                }}
              >
                {hiddenDeviceCount > 0 ? (
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 10, color: fg(0.5) }}>
                    +{hiddenDeviceCount}
                  </Text>
                ) : (
                  <Plus size={12} strokeWidth={2.2} color={fg(0.5)} />
                )}
              </View>
            </View>

            {/* 右侧文案：汇总（caption 11 medium）+ Connect in Control ›（micro 10）*/}
            <View style={{ alignItems: "flex-end", paddingRight: 4 }}>
              <Text
                numberOfLines={1}
                style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 14, color: fg(0.75) }}
              >
                {deviceStripSummary(connectedCount, devicesLoading, devicesError, hiddenDeviceCount)}
              </Text>
              <View style={{ marginTop: 2, flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 13, color: fg(0.45) }}>
                  {t("view.connectInControl")}
                </Text>
                <ChevronRight size={9} strokeWidth={2} color={fg(0.45)} />
              </View>
            </View>
          </GlassCard>
        </Pressable>

        {/* 叙事摘要卡（dev AmbientView "TODAY · LOCAL SUMMARY"）：≥2 条可见事件才出。 */}
        {narrativeSummary ? (
          <View style={{ marginTop: 20, borderRadius: 16, overflow: "hidden" }}>
            <LinearGradient
              colors={["hsl(220, 50%, 98%)", "hsl(260, 40%, 97%)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ padding: 16, borderRadius: 16, borderWidth: 1, borderColor: "hsla(0, 0%, 100%, 0.5)" }}
            >
              <View className="flex-row items-center justify-between" style={{ marginBottom: 8 }}>
                <View className="flex-row items-center" style={{ gap: 6 }}>
                  <Sparkles size={11} color={PINK_BRIGHT} />
                  <Text style={{ fontFamily: "Inter_700Bold", fontSize: 10, letterSpacing: 1.6, color: PINK }}>
                    {t("view.todayLocalSummary")}
                  </Text>
                </View>
                <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, color: fg(0.45) }}>
                  {t("view.entries", { count: timelineEntries.length })}
                </Text>
              </View>
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20, color: fg(0.85) }}>
                {narrativeSummary}
              </Text>
            </LinearGradient>
          </View>
        ) : null}

        {/* 待摘要转写积压但零时间线事件 → 引导装端侧模型卡（dev AmbientView:727-729）。 */}
        {pendingTranscriptWindows.length > 0 && timelineEntries.length === 0 && onOpenModelSetup ? (
          <AmbientModelRequiredCard onOpenSetup={onOpenModelSetup} />
        ) : null}

        {/* TODAY 时间线：三路 TimelineEntry(LLM 事件 + 最近原始事件 + 待转写窗口)。图标格 +
            时间·来源 + 隐私/置信徽章 + tag + dismiss + load-more。空/加载态文案逐字对齐 dev。 */}
        {timelineEntries.length === 0 ? (
          <GlassCard className="mt-5" style={{ padding: 16, alignItems: "center" }}>
            {timelineLoading ? (
              <ActivityIndicator color="#a1a1aa" style={{ marginBottom: 8 }} />
            ) : null}
            <Text
              className="text-center"
              style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 18, color: fg(0.8) }}
            >
              {timelineLoading ? t("view.buildingTimeline") : t("view.noTimelineEvents")}
            </Text>
            {/* dev :774-780：有错误显示错误，否则按开关状态给提示。 */}
            <Text
              className="text-center"
              style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 17, color: fg(0.5), marginTop: 4 }}
            >
              {timelineError
                ? timelineError
                : ambientOn
                  ? t("view.emptyKeepOn")
                  : t("view.emptyTurnOn")}
            </Text>
            {/* dev :781-785：本地 store 故障单独一行红字。 */}
            {storeStatus?.lastError ? (
              <Text
                className="text-center"
                style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: "#ef4444", marginTop: 8 }}
              >
                {storeStatus.lastError}
              </Text>
            ) : null}
          </GlassCard>
        ) : (
          <View style={{ marginTop: 20, gap: 10 }}>
            {visibleTimelineEntries.map((entry) => {
              const Tile = entry.icon;
              const Chip = entry.device.icon;
              const privacyLabel =
                entry.privacyTag === "private"
                  ? t("view.privateBadge")
                  : entry.privacyTag === "sensitive"
                    ? t("view.sensitiveBadge")
                    : null;
              return (
                <GlassCard key={entry.id ?? entry.time + entry.title} style={{ padding: 14 }}>
                  <View className="flex-row" style={{ gap: 12 }}>
                    {/* 图标格 40 rounded-xl */}
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: fg(0.04),
                        borderWidth: 1,
                        borderColor: fg(0.06),
                      }}
                    >
                      <Tile size={17} strokeWidth={1.7} color={fg(0.75)} />
                    </View>
                    <View className="flex-1">
                      {/* 头部行：[time · device · 隐私 · uncertain] 左，dismiss ✕ 右 */}
                      <View className="flex-row items-start justify-between" style={{ gap: 8 }}>
                        <View className="flex-1 flex-row items-center" style={{ flexWrap: "wrap", gap: 6 }}>
                          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, lineHeight: 15, color: fg(0.7) }}>
                            {entry.time}
                          </Text>
                          <Text style={{ fontSize: 11, lineHeight: 15, color: fg(0.3) }}>·</Text>
                          <View className="flex-row items-center" style={{ gap: 4 }}>
                            <Chip size={11} strokeWidth={2} color={PINK} />
                            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: PINK }}>
                              {entry.device.name}
                            </Text>
                          </View>
                          {privacyLabel ? (
                            <>
                              <Text style={{ fontSize: 11, lineHeight: 15, color: fg(0.3) }}>·</Text>
                              <View className="flex-row items-center" style={{ gap: 3 }}>
                                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "hsl(304, 75%, 63%)" }} />
                                <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: PINK_BRIGHT }}>
                                  {privacyLabel}
                                </Text>
                              </View>
                            </>
                          ) : null}
                          {entry.confidenceLabel === "uncertain" ? (
                            <>
                              <Text style={{ fontSize: 11, lineHeight: 15, color: fg(0.3) }}>·</Text>
                              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
                                {t("view.uncertainBadge")}
                              </Text>
                            </>
                          ) : null}
                        </View>
                        {entry.onDismiss ? (
                          <Pressable
                            onPress={entry.onDismiss}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t("view.dismissAria")}
                          >
                            <X size={13} color={fg(0.3)} />
                          </Pressable>
                        ) : null}
                      </View>
                      {/* 标题 */}
                      <Text
                        style={{
                          fontFamily: "Inter_600SemiBold",
                          fontSize: 13,
                          lineHeight: 18,
                          color: fg(),
                          marginTop: 4,
                          marginBottom: 4,
                        }}
                      >
                        {entry.title}
                      </Text>
                      {/* 正文 */}
                      {entry.body ? (
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 18, color: fg(0.65) }}>
                          {entry.body}
                        </Text>
                      ) : null}
                      {/* tags */}
                      {entry.tags.length > 0 ? (
                        <View className="flex-row" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                          {entry.tags.map((tag) => (
                            <View
                              key={tag}
                              style={{ borderRadius: 999, backgroundColor: fg(0.05), paddingHorizontal: 8, paddingVertical: 2 }}
                            >
                              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                                #{tag}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      {/* Triggered NOW card（dev AmbientView:867-906）：带 action 的条目
                          "Open →" 把事件送进现有 CardChat 运行时（Ambient→Action 唯一
                          handoff）；无 action 的保持装饰性展示。 */}
                      {entry.triggeredCard ? (
                        <View style={{ marginTop: 10, borderRadius: 12, overflow: "hidden" }}>
                          <LinearGradient
                            colors={["hsla(304, 75%, 63%, 0.07)", "hsla(304, 75%, 63%, 0.02)"]}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={{
                              padding: 10,
                              borderRadius: 12,
                              borderWidth: 1,
                              borderColor: "hsla(304, 75%, 63%, 0.18)",
                            }}
                          >
                            <Text
                              style={{
                                fontFamily: "Inter_700Bold",
                                fontSize: 10,
                                lineHeight: 14,
                                letterSpacing: 1.4,
                                textTransform: "uppercase",
                                color: PINK,
                                marginBottom: 4,
                              }}
                            >
                              {t("view.triggeredThisCard")}
                            </Text>
                            <View className="flex-row items-center justify-between" style={{ gap: 8 }}>
                              <View className="flex-1 flex-row items-center" style={{ gap: 6 }}>
                                <Sparkles size={11} color={PINK_BRIGHT} />
                                <Text
                                  numberOfLines={1}
                                  className="flex-1"
                                  style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.85) }}
                                >
                                  {entry.triggeredCard}
                                </Text>
                              </View>
                              <Pressable
                                onPress={entry.action && onOpenChat ? () => handleAmbientAction(entry) : undefined}
                                hitSlop={8}
                                accessibilityRole="button"
                              >
                                <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, lineHeight: 15, color: PINK }}>
                                  {t("view.open")}
                                </Text>
                              </Pressable>
                            </View>
                          </LinearGradient>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </GlassCard>
              );
            })}
            {visibleTimelineEntries.length < timelineEntries.length ? (
              <Pressable
                onPress={() => setVisibleCount((c) => Math.min(c + TIMELINE_LOAD_MORE, timelineEntries.length))}
                accessibilityRole="button"
              >
                <View
                  style={{
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: fg(0.08),
                    backgroundColor: fg(0.035),
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, lineHeight: 16, color: fg(0.65) }}>
                    {t("view.loadMore", { count: timelineEntries.length - visibleTimelineEntries.length })}
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </View>
        )}

        {/* 底部 hint（web AmbientView bottom hint）*/}
        <View
          className="flex-row items-center justify-center"
          style={{ marginTop: 20, gap: 6 }}
        >
          <Lightbulb size={10} color={fg(0.4)} />
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4), flexShrink: 1 }}>
            {ambientOn
              ? t("view.hintLiveAssist")
              : t("view.hintEnableAssist")}
          </Text>
        </View>
      </ScrollView>

      {/* 全屏 focus overlay（Focus 钮打开；Modal 全屏接管）。渲染用
          liveSession ?? fullscreenSession（dev LiveOverlay:32）：有实时流时跟流
          （新转写继续进来），fullscreenSession 只当「保持打开」的快照兜底。 */}
      {fullscreenSession ? (
        <LiveFullscreen
          session={liveSession ?? fullscreenSession}
          onClose={() => setFullscreenSession(null)}
        />
      ) : null}
    </View>
  );
}

// ── web AmbientView hero switch 的自定义视觉（渐变玻璃卡 + 图标 + 锁 + 开关）──

/** 渐变玻璃卡（对齐 web hero：rounded-2xl(16) + blur(20) + 白渐变 0.4→0.25 / 0.7→0.4
 *  + border white/0.5 + on 态外影）。比 GlassCard strong 更透、圆角更小。 */
function AmbientHeroCard({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <View
      style={{
        marginTop: 12,
        borderRadius: 16,
        boxShadow: on ? "0 4px 24px hsla(0, 0%, 0%, 0.06)" : undefined,
      }}
    >
      <View style={[StyleSheet.absoluteFill, { borderRadius: 16, overflow: "hidden" }]} pointerEvents="none">
        <BlurView intensity={28} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={
            on
              ? ["rgba(255,255,255,0.7)", "rgba(255,255,255,0.4)"]
              : ["rgba(255,255,255,0.4)", "rgba(255,255,255,0.25)"]
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: "rgba(255,255,255,0.5)" },
          ]}
        />
      </View>
      <View className="flex-row items-center justify-between px-4" style={{ paddingVertical: 18 }}>{children}</View>
    </View>
  );
}

/** upload 软锁钮（web w-9 h-9=36 圆 + border；锁=实心 foreground，开=极淡）。 */
function LockButton({ locked, onPress }: { locked: boolean; onPress: () => void }) {
  const { t } = useTranslation("ambient");
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={locked ? t("view.unlockUploads") : t("view.lockUploads")}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          backgroundColor: locked ? fg() : fg(0.04),
          borderColor: locked ? fg() : fg(0.15),
        }}
      >
        {locked ? (
          <Lock size={14} strokeWidth={2.2} color={BG} />
        ) : (
          <Unlock size={14} strokeWidth={2.2} color={fg(0.6)} />
        )}
      </View>
    </Pressable>
  );
}

/** 雷达图标（web Radio 14 / 32 圆 + on 态 ping 脉冲 + 绿点）。圆底内联 hsla 保证渲染。 */
function AmbientStatusIcon({ on }: { on: boolean }) {
  return (
    <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
      {on ? <PingRing /> : null}
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: on ? fg() : fg(0.1),
        }}
      >
        <Radio size={14} strokeWidth={2.2} color={on ? BG : fg(0.4)} />
      </View>
      {on ? (
        <View
          style={{
            position: "absolute",
            top: -1,
            right: -1,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: "#10b981",
            borderWidth: 2,
            borderColor: BG,
          }}
        />
      ) : null}
    </View>
  );
}

/** web Tailwind animate-ping 等价：1s 内 scale 1→2 + opacity 0.15→0（前 75% 扩散
 *  渐隐、后 25% 停在不可见再 snap 回，形成"雷达 blip"节奏），bezier(0,0,.2,1)。
 *  底色用 fg() 满不透明，由动画 opacity 控到峰值 15%（= web bg-foreground/15）。 */
function PingRing() {
  const pageActive = usePageActive();
  const covered = useFullCover();
  const t = useSharedValue(0);
  useEffect(() => {
    // 页面隐藏/被全屏 sheet 盖住时停帧（keep-alive 常驻后无限循环不能空跑；
    // covered 维度=审查 F3,与 NowScreen BreatheHalo 同款双门控）。
    if (!pageActive || covered) return;
    t.value = withRepeat(
      withTiming(1, { duration: 1000, easing: Easing.bezier(0, 0, 0.2, 1) }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(t);
      t.value = 0;
    };
  }, [t, pageActive, covered]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(t.value, [0, 0.75, 1], [1, 2, 2]) }],
    opacity: interpolate(t.value, [0, 0.75, 1], [0.15, 0, 0]),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", width: 32, height: 32, borderRadius: 16, backgroundColor: fg() },
        style,
      ]}
    />
  );
}

/** 自定义开关（web w-12 h-7 = 48×28 + 24 拇指，spring 500/35），替原生 Switch。
 *  pending（翻转在途）时降透明 + 禁点，对齐 dev disabled:opacity-60。 */
function AmbientToggle({ on, pending = false, onPress }: { on: boolean; pending?: boolean; onPress: () => void }) {
  const x = useSharedValue(on ? 20 : 0);
  useEffect(() => {
    x.value = withSpring(on ? 20 : 0, { stiffness: 500, damping: 35 });
  }, [on, x]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled: pending }}
    >
      <View
        style={{
          width: 48,
          height: 28,
          borderRadius: 14,
          justifyContent: "center",
          opacity: pending ? 0.6 : 1,
          backgroundColor: on ? fg() : fg(0.2),
        }}
      >
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 2,
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: BG,
              shadowColor: "#000",
              shadowOpacity: 0.12,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 1 },
            },
            thumbStyle,
          ]}
        />
      </View>
    </Pressable>
  );
}
