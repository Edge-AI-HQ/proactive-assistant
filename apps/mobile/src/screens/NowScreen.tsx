/**
 * NOW 首页——web NowView 的完整 RN 对应物（UI 刀 2）：
 * 问候页头（Hi, Name 粉渐变）→ Ambient 状态卡（圆图标+toggle，点卡体
 * 进 Ambient 页）→ 3D 球面卡片云（tap → 详情抽屉 → 四操作）→
 * 底部 ASK PIN AI。协议层（cards query / feedback builders / outbox
 * 兜底）与此前一致。
 */
import { useCallback, useEffect, useState } from "react";
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
import { useCardsQuery } from "@pin-ai/state";

import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";
import AskPinAiBar from "../components/app/AskPinAiBar";
import PageHeader from "../components/app/PageHeader";
import CardDetailSheet from "../components/now/CardDetailSheet";
import SphereCards, { type SphereItem } from "../components/now/SphereCards";
import { GradientText } from "../ui/GradientText";
import { EM_TIGHT, leading, tracking } from "../ui/typography";
import { useCardActions } from "../hooks/useCardActions";
import { supabase } from "../lib/supabase";
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
        <View
          className={`h-8 w-8 items-center justify-center rounded-full ${on ? "bg-foreground" : "bg-foreground/30"}`}
        >
          {on ? <BreatheHalo borderRadius={16} scaleTo={1.38} duration={2400} /> : null}
          <Radio size={14} color={on ? "#ffffff" : "rgba(255,255,255,0.6)"} strokeWidth={2} />
          {on ? <View style={styles.sensingDot} /> : null}
        </View>
        <View className="flex-1">
          <Text
            className={`text-[14px] ${on ? "text-foreground" : "text-foreground/70"}`}
            style={{ fontFamily: "Inter_600SemiBold" }}
          >
            {on ? "Ambient is on" : "Ambient is off"}
          </Text>
          <Text className="mt-0.5 text-[12px] text-foreground/50" style={{ fontFamily: "Inter_400Regular" }}>
            {on ? "Sensing context around you" : "Tap to start sensing context"}
          </Text>
        </View>
      </Pressable>
      {/* web 自绘 w-11 h-6 pill toggle。 */}
      <Pressable
        onPress={() => void toggle(!on)}
        hitSlop={8}
        className={`h-6 w-11 rounded-full ${on ? "bg-foreground" : "bg-foreground/20"}`}
      >
        {on ? <BreatheHalo borderRadius={12} scaleTo={1.4} duration={2000} /> : null}
        <Animated.View style={[styles.knob, knobStyle]} />
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

  const visible = cards.filter(
    (e) => !isHiddenCardOutcome(e.latestOutcome) && !hidden.has(e.card.id),
  );
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

  const { confirm, steer, snooze, dismiss } = useCardActions({
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
        onConfirm={confirm}
        onSteer={steer}
        onSnooze={snooze}
        onDismiss={dismiss}
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
