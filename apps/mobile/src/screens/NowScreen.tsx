/**
 * NOW 首页——web NowView 的完整 RN 对应物（UI 刀 2）：
 * 问候页头（Hi, Name 粉渐变）→ Ambient 状态卡（圆图标+toggle，点卡体
 * 进 Ambient 页）→ 3D 球面卡片云（tap 分流：执行态直进 card chat，新卡
 * → 详情抽屉 → 四操作）/ 零卡空态引导（HomeEmptyState）→ 底部 ASK
 * PIN AI。动作与乐观集合来自壳级 CardActionsProvider（NOW/TASKS 单实例）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Radio } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  basketToLovableCategory,
  deriveCardUiStatus,
  isHiddenCardOutcome,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardsQuery, useWeatherData } from "@pin-ai/state";

import { AmbientAudio } from "../../modules/ambient-audio";
import AskPinAiBar from "../components/app/AskPinAiBar";
import { useCardActionsContext } from "../components/app/CardActionsProvider";
import PageHeader from "../components/app/PageHeader";
import CardDetailSheet from "../components/now/CardDetailSheet";
import HomeEmptyState, { type VoicePermissionState } from "../components/now/HomeEmptyState";
import SphereCards, { type SphereItem } from "../components/now/SphereCards";
// __HEAT_AB__ 混合渲染开关(Skia 背景层 + 原生文字);定位完删。
import { useHeatAbFlags } from "../lib/heat-ab";
import { GradientText } from "../ui/GradientText";
import { EM_TIGHT, tracking } from "../ui/typography";
import { usePageActive } from "../components/app/KeepAlivePage";
import { useAmbientToggle } from "../hooks/useAmbientToggle";
import { useFullCover } from "../lib/full-cover";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount, probeSet } from "../lib/heat-probe";
import { getDeviceWeatherCoords } from "../lib/weather-location";
import type { HeaderProps } from "./AmbientScreen";

/** web ambient-{toggle,icon}-breathe 对应物：emerald 扩散波（boxShadow
 *  0→spread 扩散不可动画，用同形叠层 scale+fade 模拟）。 */
function BreatheHalo({
  borderRadius,
  scaleTo,
  duration,
}: {
  borderRadius: number;
  scaleTo: number;
  duration: number;
}) {
  const t = useSharedValue(0);
  // 页面可见 && 未被全屏 sheet 盖住才循环(AskPinAiBar chevron 同款双门控);隐藏时
  // cancel 并归零——NOW 常驻挂载(keep-alive),不门控这个 withRepeat 会永远空转
  // (阶段 2 审计漏网点,2026-07-05 补)。
  const pageActive = usePageActive();
  const covered = useFullCover();
  const running = pageActive && !covered;
  useEffect(() => {
    if (!running) {
      cancelAnimation(t);
      t.value = 0;
      probeSet("now.breatheHalo", "stopped"); // __HEAT_PROBE__
      return;
    }
    t.value = withRepeat(withTiming(1, { duration, easing: Easing.out(Easing.ease) }), -1, false);
    probeSet("now.breatheHalo", "looping"); // __HEAT_PROBE__
    return () => cancelAnimation(t);
  }, [t, duration, running]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + t.value * (scaleTo - 1) }],
    opacity: 0.35 * (1 - t.value),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius, backgroundColor: "hsl(160, 84%, 39%)" }, style]}
    />
  );
}

/** web NowView ambient 行 1:1：灰调淡卡（非玻璃）+ 黑图标圆（breathe）+
 *  自绘 w-11 h-6 pill toggle（knob tween 0.2s + breathe halo）。 */
function AmbientStatusCard({
  userId,
  onOpenAmbient,
}: {
  userId: string | null;
  onOpenAmbient: () => void;
}) {
  const { t } = useTranslation(["card", "common"]);
  // 主开关走共享 useAmbientToggle（与 Ambient tab 同一真源：patch consent + 启停 runtime，本机闸走
  // runtime 共享 store）——任一处翻转两处都同步。别名 ambientOn→on，下方视觉沿用 on 不改。
  const { ambientOn: on, togglePending, toggle } = useAmbientToggle(userId);
  // ambient 开时副标题 = 位置·天气·温度。复用 @pin-ai/state 共享 hook + 注入设备 GPS（已授权时，
  // 复用 ambient 的 expo-location 权限；未授权回退 IP 定位）。weather=null（加载/失败）时回退文案。
  const weather = useWeatherData(getDeviceWeatherCoords);
  const knob = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    knob.value = withTiming(on ? 1 : 0, { duration: 200, easing: Easing.inOut(Easing.ease) });
  }, [on, knob]);
  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: knob.value * 20 }],
  }));

  return (
    <View className="mx-5 mt-4 flex-row items-center gap-3 rounded-2xl px-3 py-2.5 bg-foreground/[0.04] border border-foreground/[0.06]">
      <Pressable onPress={onOpenAmbient} className="flex-1 flex-row items-center gap-3">
        <View className="h-8 w-8 items-center justify-center">
          {/* 绿环只在圆「外圈」扩散：halo 放实心圆「背后」（先渲染），实心圆盖住中心，
              只有超出圆的部分显绿 → 外圈闪、内部不闪。scaleTo 1.38→1.5（移到背后需更大才看得见）。 */}
          {on ? <BreatheHalo borderRadius={16} scaleTo={1.5} duration={2400} /> : null}
          <View
            className={`absolute inset-0 items-center justify-center rounded-full ${on ? "bg-foreground" : "bg-foreground/30"}`}
          >
            <Radio size={14} color={on ? "#ffffff" : "rgba(255,255,255,0.6)"} strokeWidth={2} />
          </View>
          {on ? <View style={styles.sensingDot} /> : null}
        </View>
        <View className="flex-1">
          <Text
            className={`text-[14px] ${on ? "text-foreground" : "text-foreground/70"}`}
            style={{ fontFamily: "Inter_600SemiBold" }}
          >
            {on ? t("now.ambientOn") : t("now.ambientOff")}
          </Text>
          <Text
            numberOfLines={1}
            className="mt-0.5 text-[12px] text-foreground/50"
            style={{ fontFamily: "Inter_400Regular" }}
          >
            {/* web NowView 1:1：开 + 有天气 → 城市·天气·温度°；开 + 天气未到 → 回退
                t("now.ambientQuiet")（web NowView:131 同键）；关 → 提示。
                城市可能缺失（IP 定位失败）→ 优雅省略该段，不显示 "undefined"。
                天气条件走 i18n 语义键（common:weather.*，与 web 同键）。 */}
            {!on
              ? t("now.ambientTapToStart")
              : weather
                ? `${weather.city ? `${weather.city} · ` : ""}${t(`common:weather.${weather.conditionKey}`)} · ${weather.temp}°`
                : t("now.ambientQuiet")}
          </Text>
        </View>
      </Pressable>
      {/* web 自绘 w-11 h-6 pill toggle。轨道用「显式 px」尺寸——NativeWind 下 className h-6/w-11 的实际
          像素不一定正好 = 24/44，而白球按 px 定位（top2/left2/20×20/travel20），轨道一旦不是 24×44
          白球就错位，所以轨道写死 px。Pressable 只管 onPress。按用户要求开关无绿光 halo（绿光只留雷达图标）。 */}
      <Pressable onPress={() => void toggle()} disabled={togglePending} hitSlop={8}>
        <View
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            backgroundColor: on ? "hsl(230, 25%, 15%)" : "hsla(230, 25%, 15%, 0.2)",
          }}
        >
          <Animated.View style={[styles.knob, knobStyle]} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  knob: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
  },
  sensingDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#10b981",
    borderWidth: 2,
    borderColor: "#f2f4f8",
  },
});

/** web NowView 问候排版：text-[30px] font-semibold tracking-tight leading-[1.05]。 */
const greetingStyle = {
  fontFamily: "Inter_600SemiBold",
  fontSize: 30,
  letterSpacing: tracking(30, EM_TIGHT),
  // 行高 = 字号 + 4(和各 section 标题 24+4=28 同规则):上方留白一致 → 顶部与 24px 的
  // section 标题对齐;比 +8 再紧一点让标题整体上移一点点(用户 2026-07-04)。
  lineHeight: 34,
} as const;

/** web hooks/useVoicePermission 的 RN 版（空态 "Turn on voice" 行的数据源）：
 *  读 AmbientAudio（ambient 声源同一原生模块）的 OS 麦克风权限，mount 不触发
 *  系统弹窗；request() 才弹。RN 恒 native → 无 web 的 "unsupported" 分支。 */
function useVoicePermission(): {
  state: VoicePermissionState;
  request: () => Promise<VoicePermissionState>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<VoicePermissionState>("missing");

  const refresh = useCallback(async () => {
    try {
      const perm = await AmbientAudio.checkPermissions();
      setState(perm.microphone === "granted" ? "granted" : "missing");
    } catch {
      // 读失败按 "missing"——nudge 保持可见是安全默认（web 同注释）。
      setState("missing");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 前台回归重读：用户可能在 iOS 设置里改了麦克风权限（web appStateChange 同构）。
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const request = useCallback(async (): Promise<VoicePermissionState> => {
    try {
      const perm = await AmbientAudio.requestPermissions();
      const next: VoicePermissionState = perm.microphone === "granted" ? "granted" : "missing";
      setState(next);
      return next;
    } catch {
      setState("missing");
      return "missing";
    }
  }, []);

  return { state, request, refresh };
}

export default function NowScreen({
  displayName,
  userId,
  headerProps,
  onOpenChat,
  onOpenAmbient,
  onAskPinAi,
  onOpenConnect,
  onReviewPermissions,
  active = true,
}: {
  displayName: string;
  userId: string | null;
  headerProps: HeaderProps;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  onOpenAmbient: () => void;
  onAskPinAi: () => void;
  /** 空态 "Connect your apps" 行 → Connect 页（AppShell wiring：navigate("connect")）。 */
  onOpenConnect?: () => void;
  /** 空态 "Review permissions" / 麦克风被拒的兜底 → 权限面板（web: Account →
   *  Ambient 子页；AppShell wiring：navigate("setting")）。未接线时退回 Ambient 页。 */
  onReviewPermissions?: () => void;
  /** false = NOW 当前不可见(切到别的页 / 被 chat 盖住)→ 球体停帧省电。 */
  active?: boolean;
}) {
  probeCount("render.NowScreen"); // __HEAT_PROBE__
  const { t } = useTranslation("card");
  const { cards, loading: feedLoading } = useCardsQuery();
  const { width } = useWindowDimensions();
  const [detail, setDetail] = useState<VisibleCardEntry | null>(null);
  // 壳级单实例动作 + 五个乐观集合（web AppLayout cardActions 经 CardStateProvider
  // 同构）：NOW/TASKS 共享，dismiss/done 立即跨屏同步，mount-restore 只跑一次。
  const cardActions = useCardActionsContext();
  const { dismissedIds, doneIds, processingIds, chattedIds, composio } = cardActions;

  // web AppLayout sphereCards 同款筛选：① 去 dismissed/done（本地乐观集合，
  // mount 时已从 /feedback/{dismissed,completed} 恢复）+ 隐藏 outcome ② 按
  // intentKey 去重（同一意图跨多次 run 只上一次；cards 按 completed_at DESC，
  // 首个即最新 run）③ 限量 14 张（web .slice(0,14)）。
  const visible = useMemo(() => {
    const seen = new Set<string>();
    return cards
      .filter(
        (e) =>
          !dismissedIds.has(e.card.id) &&
          !doneIds.has(e.card.id) &&
          !isHiddenCardOutcome(e.latestOutcome),
      )
      .filter((e) => {
        const key = e.card.intentKey || e.card.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 14);
  }, [cards, dismissedIds, doneIds]);
  const sphereItems: SphereItem[] = visible.map((e) => ({
    id: e.card.id,
    title: e.card.title,
    category: basketToLovableCategory(e.card.goalBasket),
    // web AppLayout 同一推导函数（core 共享）：engagement gate + run 状态；
    // 乐观 processing / chatted 分别喂（web sphereCards 同参）。
    status: deriveCardUiStatus({
      runStatus: e.runStatus,
      latestOutcome: e.latestOutcome,
      optimisticProcessing: processingIds.has(e.card.id),
      chatted: chattedIds.has(e.card.id),
    }),
  }));

  // ── 空态引导数据（web AppLayout:203-241 同构）──
  // ACTIVE 连接数 + 「列表确已加载」闸（加载前 0 不算没连接）+ OS 麦克风权限。
  const connectorCount = composio.connections.filter((c) => c.status === "ACTIVE").length;
  const connectorsKnown =
    !composio.statusLoading && !composio.loadingConns && composio.keyStatus?.configured === true;
  const { state: voiceState, request: requestVoicePermission, refresh: refreshVoicePermission } =
    useVoicePermission();
  const { ambientOn, toggle: toggleAmbient } = useAmbientToggle(userId);
  // 回到 NOW 时重读麦克风权限（web activeView==="now" 同构）：用户在权限面板
  // 授权后 nudge 才会自清。
  useEffect(() => {
    if (active) void refreshVoicePermission();
  }, [active, refreshVoicePermission]);
  // 未接线的兜底：Review permissions / 拒麦跳 Ambient 页（真目标 = Setting →
  // Ambient 权限子页，见 prop 注释）。
  const reviewPermissions = onReviewPermissions ?? onOpenAmbient;
  // web handleEnableVoice：就地弹 OS 麦克风请求；授权成功顺手把 ambient 打开，
  // 否则跳权限面板（OS 拒过一次就不再弹）。
  const handleEnableVoice = useCallback(async () => {
    const next = await requestVoicePermission();
    if (next === "granted") {
      if (!ambientOn) await toggleAmbient();
    } else {
      reviewPermissions();
    }
  }, [requestVoicePermission, ambientOn, toggleAmbient, reviewPermissions]);

  return (
    <View className="flex-1">
      <PageHeader
        title={
          <View className="flex-row items-end">
            <Text className="text-foreground" style={greetingStyle}>
              Hi,{" "}
            </Text>
            {/* web: bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text */}
            <GradientText
              text={displayName}
              colors={["hsl(292, 78%, 63%)", "hsl(330, 80%, 65%)"]}
              style={greetingStyle}
            />
          </View>
        }
        subtitle={t("now.feedSummary", { count: visible.length })}
        {...headerProps}
      />
      <AmbientStatusCard userId={userId} onOpenAmbient={onOpenAmbient} />
      <View className="flex-1">
        {/* 卡片区（web NowView:162-170）：有卡上球；零卡且首拉已回 → 空态引导
            （connect / voice checklist），加载中不闪空态。 */}
        {!feedLoading && visible.length === 0 ? (
          <HomeEmptyState
            connectorCount={connectorCount}
            connectorsKnown={connectorsKnown}
            voiceState={voiceState}
            onEnableVoice={() => void handleEnableVoice()}
            onConnect={onOpenConnect ?? (() => {})}
            onReviewPermissions={reviewPermissions}
          />
        ) : (
          <SphereView
            items={sphereItems}
            width={width}
            active={active}
            onTap={(id) => {
              const entry = visible.find((e) => e.card.id === id);
              if (!entry) return;
              // web AppLayout handleSphereCardTap:711-749：已进入执行态的卡
              // （processing/needs_input/ready/failed = runUi!=="normal"）直进
              // card chat 看现状，**不带 bootstrap**（重进已有 run 不再踢新
              // agent turn，drawer 的 Approve 会重复 POST confirm）；否则开抽屉。
              const item = sphereItems.find((s) => s.id === id);
              if (item && item.status !== "normal") {
                onOpenChat(entry.card, "");
              } else {
                setDetail(entry);
              }
            }}
          />
        )}
      </View>
      <AskPinAiBar onOpen={onAskPinAi} />
      <CardDetailSheet
        entry={detail}
        onClose={() => setDetail(null)}
        onDismiss={(e) => {
          cardActions.dismiss(e.card);
          setDetail(null);
        }}
        onComplete={(e) => {
          cardActions.complete(e.card);
          setDetail(null);
        }}
        onApprove={(e) => {
          void cardActions.confirm(e.card);
          setDetail(null);
        }}
        onChat={(e) => {
          cardActions.chat(e.card);
          setDetail(null);
        }}
      />
    </View>
  );
}

/** 球面区域：自适应高度（onLayout 量出后渲染——SphereCards 需要确定尺寸）。
 *  零卡空态由 NowScreen 渲染 HomeEmptyState 接管（web NowView 同位），这里
 *  只负责有卡的球面。 */
function SphereView({
  items,
  width,
  active,
  onTap,
}: {
  items: SphereItem[];
  width: number;
  active: boolean;
  onTap: (id: string) => void;
}) {
  const [height, setHeight] = useState(0);
  // __HEAT_AB__ cardsSkia=true → 混合渲染(Skia 背景层画底/影 + 原生层叠文字/图标/交互,凉);
  // false = 纯原生(底/影/边全在原生视图,量化过但仍有一丝丝阴影残热)。默认 false。
  const { cardsSkia } = useHeatAbFlags();
  return (
    <View className="flex-1" onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {height > 0 && items.length > 0 ? (
        <SphereCards
          items={items}
          width={width}
          height={height}
          active={active}
          onTap={onTap}
          skiaBg={cardsSkia}
        />
      ) : null}
    </View>
  );
}
