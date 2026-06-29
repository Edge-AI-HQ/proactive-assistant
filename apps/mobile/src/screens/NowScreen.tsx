/**
 * NOW 首页——web NowView 的完整 RN 对应物（UI 刀 2）：
 * 问候页头（Hi, Name 粉渐变）→ Ambient 状态卡（圆图标+toggle，点卡体
 * 进 Ambient 页）→ 3D 球面卡片云（tap → 详情抽屉 → 四操作）→
 * 底部 ASK PIN AI。协议层（cards query / feedback builders / outbox
 * 兜底）与此前一致。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Radio } from "lucide-react-native";
import Animated, {
  Easing,
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

import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";
import AskPinAiBar from "../components/app/AskPinAiBar";
import PageHeader from "../components/app/PageHeader";
import CardDetailSheet from "../components/now/CardDetailSheet";
import SphereCards, { type SphereItem } from "../components/now/SphereCards";
import { GradientText } from "../ui/GradientText";
import { EM_TIGHT, leading, tracking } from "../ui/typography";
import { useCardActions } from "../hooks/useCardActions";
import { supabase } from "../lib/supabase";
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
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration, easing: Easing.out(Easing.ease) }), -1, false);
  }, [t, duration]);
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
function AmbientStatusCard({ onOpenAmbient }: { onOpenAmbient: () => void }) {
  const [on, setOn] = useState(false);
  // ambient 开时副标题 = 位置·天气·温度。复用 @pin-ai/state 共享 hook + 注入设备 GPS（已授权时，
  // 复用 ambient 的 expo-location 权限；未授权回退 IP 定位）。weather=null（加载/失败）时回退文案。
  const weather = useWeatherData(getDeviceWeatherCoords);
  useEffect(() => {
    void isAmbientEnabled().then(setOn);
  }, []);
  const knob = useSharedValue(0);
  useEffect(() => {
    knob.value = withTiming(on ? 1 : 0, { duration: 200, easing: Easing.inOut(Easing.ease) });
  }, [on, knob]);
  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: knob.value * 20 }],
  }));

  const toggle = async (next: boolean) => {
    setOn(next);
    if (next) {
      const { data } = await supabase.auth.getUser();
      if (!data.user?.id) return;
      const started = await startAmbient(data.user.id);
      if (started.length === 0) setOn(false);
    } else {
      await stopAmbient();
    }
  };
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
            {on ? "Ambient is on" : "Ambient is off"}
          </Text>
          <Text
            numberOfLines={1}
            className="mt-0.5 text-[12px] text-foreground/50"
            style={{ fontFamily: "Inter_400Regular" }}
          >
            {/* web NowView 1:1：开 + 有天气 → 城市·天气·温度°；开 + 天气未到 → 回退；关 → 提示。
                城市可能缺失（IP 定位失败）→ 优雅省略该段，不显示 "undefined"。 */}
            {!on
              ? "Tap to start sensing context"
              : weather
                ? `${weather.city ? `${weather.city} · ` : ""}${weather.label} · ${weather.temp}°`
                : "Sensing context around you"}
          </Text>
        </View>
      </Pressable>
      {/* web 自绘 w-11 h-6 pill toggle。轨道用「显式 px」尺寸——NativeWind 下 className h-6/w-11 的实际
          像素不一定正好 = 24/44，而白球按 px 定位（top2/left2/20×20/travel20），轨道一旦不是 24×44
          白球就错位，所以轨道写死 px。Pressable 只管 onPress。按用户要求开关无绿光 halo（绿光只留雷达图标）。 */}
      <Pressable onPress={() => void toggle(!on)} hitSlop={8}>
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
  lineHeight: leading(30, 1.05),
} as const;

export default function NowScreen({
  displayName,
  headerProps,
  onOpenChat,
  onOpenAmbient,
  onAskPinAi,
}: {
  displayName: string;
  headerProps: HeaderProps;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  onOpenAmbient: () => void;
  onAskPinAi: () => void;
}) {
  const { cards } = useCardsQuery();
  const { width } = useWindowDimensions();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // 本地乐观「用户碰过这张卡」集合（web processingIds/chattedIds 的合并简化）。
  const [engaged, setEngaged] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<VisibleCardEntry | null>(null);

  // web AppLayout sphereCards 同款筛选：① 去掉隐藏/本地 hide 的卡 ② 按 intentKey
  // 去重（同一意图跨多次 run 只上一次；cards 按 completed_at DESC，首个即最新 run）
  // ③ 限量 14 张。RN 之前全量上球 → "渲染太多"，此处对齐 web 的 .slice(0,14)。
  const visible = useMemo(() => {
    // web AppLayout sphereCards 1:1 过滤：去 dismissed/done（按 card.id，本地 hidden——dismiss/done
    // 时乐观加 + mount 时从后端 /feedback/{dismissed,completed} 恢复，见 useCardActions）
    // + 隐藏 outcome，再按 intentKey dedup（同意图多 run 只上最新一条），slice 14。
    const seen = new Set<string>();
    return cards
      .filter((e) => !isHiddenCardOutcome(e.latestOutcome) && !hidden.has(e.card.id))
      .filter((e) => {
        const key = e.card.intentKey || e.card.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 14);
  }, [cards, hidden]);
  const sphereItems: SphereItem[] = visible.map((e) => ({
    id: e.card.id,
    title: e.card.title,
    category: basketToLovableCategory(e.card.goalBasket),
    // web AppLayout 同一推导函数（core 共享）：engagement gate + run 状态。
    status: deriveCardUiStatus({
      runStatus: e.runStatus,
      latestOutcome: e.latestOutcome,
      optimisticProcessing: engaged.has(e.card.id),
      chatted: engaged.has(e.card.id),
    }),
  }));

  const hide = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
  }, []);
  const engage = useCallback((id: string) => {
    setEngaged((prev) => new Set(prev).add(id));
  }, []);

  const { confirm, dismiss, complete, chat } = useCardActions({
    onOpenChat,
    onHide: hide,
    onEngage: engage,
    onClose: () => setDetail(null),
  });

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
        subtitle={`Your proactive feed · ${visible.length} cards today`}
        {...headerProps}
      />
      <AmbientStatusCard onOpenAmbient={onOpenAmbient} />
      <View className="flex-1">
        <SphereView
          items={sphereItems}
          width={width}
          onTap={(id) => {
            const entry = visible.find((e) => e.card.id === id);
            if (entry) setDetail(entry);
          }}
        />
      </View>
      <AskPinAiBar onOpen={onAskPinAi} />
      <CardDetailSheet
        entry={detail}
        onClose={() => setDetail(null)}
        onDismiss={dismiss}
        onComplete={complete}
        onApprove={confirm}
        onChat={chat}
      />
    </View>
  );
}

/** 球面区域：自适应高度（onLayout 量出后渲染——SphereCards 需要确定尺寸）。 */
function SphereView({
  items,
  width,
  onTap,
}: {
  items: SphereItem[];
  width: number;
  onTap: (id: string) => void;
}) {
  const [height, setHeight] = useState(0);
  return (
    <View className="flex-1" onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {height > 0 && items.length > 0 ? (
        <SphereCards items={items} width={width} height={height} onTap={onTap} />
      ) : items.length === 0 ? (
        <View className="flex-1 items-center justify-center px-10">
          <Text className="text-center text-[14px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            All clear — PIN AI is watching for what's next.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
