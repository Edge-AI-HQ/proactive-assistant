/**
 * NOW 首页——web NowView 的完整 RN 对应物（UI 刀 2）：
 * 问候页头（Hi, Name 粉渐变）→ Ambient 状态卡（圆图标+toggle，点卡体
 * 进 Ambient 页）→ 3D 球面卡片云（tap → 详情抽屉 → 四操作）→
 * 底部 ASK PIN AI。协议层（cards query / feedback builders / outbox
 * 兜底）与此前一致。
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, Text, View, useWindowDimensions } from "react-native";
import { Radio } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import {
  cardActionFeedbackBody,
  confirmBootstrap,
  dismissFeedbackBody,
  isHiddenCardOutcome,
  proxyPost,
  snoozeFeedbackBody,
  steerBootstrap,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardsQuery } from "@pin-ai/state";

import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";
import AskPinAiBar from "../components/app/AskPinAiBar";
import PageHeader from "../components/app/PageHeader";
import CardDetailSheet from "../components/now/CardDetailSheet";
import SphereCards, { type SphereItem } from "../components/now/SphereCards";
import { GlassCard } from "../ui/GlassCard";
import { enqueueFeedback } from "../lib/sync/sync-bootstrap";
import { supabase } from "../lib/supabase";
import type { HeaderProps } from "./AmbientScreen";

async function postFeedback(body: Record<string, unknown>, dedupeKey?: string): Promise<void> {
  try {
    await proxyPost("/feedback", body);
  } catch {
    await enqueueFeedback(body, dedupeKey);
  }
}

function AmbientStatusCard({ onOpenAmbient }: { onOpenAmbient: () => void }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void isAmbientEnabled().then(setOn);
  }, []);
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
    <GlassCard className="mx-5 mt-1 flex-row items-center px-4 py-3.5">
      <Pressable onPress={onOpenAmbient} className="flex-1 flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-white/80 border border-white/70">
          <Radio size={15} color={on ? "#16a34a" : "#a1a1aa"} strokeWidth={1.8} />
        </View>
        <View className="flex-1">
          <Text className="text-[14px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
            {on ? "Ambient is on" : "Ambient is off"}
          </Text>
          <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            {on ? "Sensing context around you" : "Tap to start sensing context"}
          </Text>
        </View>
      </Pressable>
      <Switch value={on} onValueChange={(v) => void toggle(v)} />
    </GlassCard>
  );
}

export default function NowScreen({
  headerProps,
  onOpenChat,
  onOpenAmbient,
  onAskPinAi,
}: {
  headerProps: HeaderProps;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
  onOpenAmbient: () => void;
  onAskPinAi: () => void;
}) {
  const { cards } = useCardsQuery();
  const { width } = useWindowDimensions();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<VisibleCardEntry | null>(null);

  const visible = cards.filter(
    (e) => !isHiddenCardOutcome(e.latestOutcome) && !hidden.has(e.card.id),
  );
  const sphereItems: SphereItem[] = visible.map((e) => ({
    id: e.card.id,
    title: e.card.title,
    categoryLabel: e.card.goalBasket,
    ready: e.latestOutcome === null && !!e.runId,
  }));

  const hide = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
  }, []);

  const confirm = (e: VisibleCardEntry) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void postFeedback(cardActionFeedbackBody("confirm", e.card), `fb:confirm:${e.card.id}`);
    setDetail(null);
    onOpenChat(e.card, confirmBootstrap(e.card));
  };
  const steer = (e: VisibleCardEntry) => {
    void postFeedback(cardActionFeedbackBody("modify", e.card), `fb:modify:${e.card.id}`);
    setDetail(null);
    onOpenChat(e.card, steerBootstrap(e.card));
  };
  const snooze = (e: VisibleCardEntry) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    hide(e.card.id);
    setDetail(null);
    void postFeedback(snoozeFeedbackBody(e.card), `fb:snooze:${e.card.id}`);
  };
  const dismiss = (e: VisibleCardEntry) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    hide(e.card.id);
    setDetail(null);
    void postFeedback(dismissFeedbackBody(e.card), `fb:dismiss:${e.card.id}`);
  };

  return (
    <View className="flex-1">
      <PageHeader
        title={
          <Text className="text-[28px] leading-9" style={{ fontFamily: "Inter_700Bold" }}>
            <Text className="text-foreground">Hi, </Text>
            <Text style={{ color: "#d646c8" }}>Boliang</Text>
          </Text>
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
