/**
 * TASKS 页——web CardTimeline 的 RN 对应物：日期分组（Today/Yesterday/Mon d）
 * + 玻璃行（分类图标 + 标题 + 状态环 + previewText + 时间）。状态语义来自 core
 * deriveCardUiStatus（服务端 runStatus 真相源；RN 无 web 的乐观 id 集，resolved
 * 由 latestOutcome 派生——同一服务端语义）。
 *
 * 点行分流（对齐 web CardTimeline:166）：活跃卡（processing/needs_input/ready/
 * failed）→ card chat；新卡（normal）→ 详情面板（confirm/steer/snooze/dismiss），
 * 复用 NOW 同款 CardDetailSheet + useCardActions（动作两屏唯一真源）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import {
  Bell,
  CheckCircle2,
  Circle,
  CircleAlert,
  Plug,
  Sparkles,
  XCircle,
} from "lucide-react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  basketToLovableCategory,
  connectorSlugFromIntentKey,
  deriveCardUiStatus,
  isReminderCard,
  sourceAppMeta,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardsQuery } from "@pin-ai/state";

import PageHeader from "../components/app/PageHeader";
import CardDetailSheet from "../components/now/CardDetailSheet";
import { CATEGORIES } from "../components/now/SphereCards";
import { GlassCard } from "../ui/GlassCard";
import { useCardActions } from "../hooks/useCardActions";
import type { HeaderProps } from "./AmbientScreen";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** 行左侧分类图标（对齐 web CardTimeline:108-117 三选一）：连接器卡 → Plug；
 *  提醒卡 → Bell；否则 basket 类目图标。复用 NOW 球面同款 CATEGORIES，保证
 *  同一张卡两处图标一致。 */
function categoryIcon(card: IntentCard) {
  if (connectorSlugFromIntentKey(card.intentKey)) return Plug;
  if (isReminderCard(card)) return Bell;
  const cat = basketToLovableCategory(card.goalBasket);
  return (CATEGORIES[cat] ?? CATEGORIES.life).icon;
}

/** needs_input 徽章呼吸闪烁（web animate-pulse 的 RN 对应物）。 */
function Pulse({ children }: { children: ReactNode }) {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(
      withTiming(0.35, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function Row({
  entry,
  onOpenChat,
  onOpenDetail,
}: {
  entry: VisibleCardEntry;
  onOpenChat: (card: IntentCard) => void;
  onOpenDetail: (entry: VisibleCardEntry) => void;
}) {
  const card = entry.card;
  const resolved =
    entry.latestOutcome === "dismiss"
    || entry.latestOutcome === "complete"
    || entry.latestOutcome === "snooze";
  const runUi = resolved
    ? "normal"
    : deriveCardUiStatus({
        runStatus: entry.runStatus,
        latestOutcome: entry.latestOutcome,
        optimisticProcessing: false,
        chatted: false,
      });
  const reminder = isReminderCard(card);
  const actionCount = card.secondaryActions?.length ?? 0;
  const CatIcon = categoryIcon(card);
  const previewText =
    entry.latestOutcome === "complete"
      ? "Completed"
      : entry.latestOutcome === "dismiss"
      ? "Dismissed"
      : entry.latestOutcome === "snooze"
      ? "Snoozed"
      : runUi === "processing"
      ? "Processing..."
      : runUi === "needs_input"
      ? "Waiting for your input"
      : runUi === "ready"
      ? "Ready for review"
      : runUi === "failed"
      ? "Failed"
      : reminder
      ? card.summary
      : card.primaryAction
      ? `${actionCount + 1} operations · ${card.primaryAction.label}`
      : (card.sourceApps ?? []).map((s) => sourceAppMeta(s).label).join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={() => (runUi !== "normal" ? onOpenChat(card) : onOpenDetail(entry))}
    >
      <GlassCard className="mb-2 px-3.5 py-3.5">
        <View style={styles.rowTop}>
          <CatIcon size={16} color="rgba(29,33,48,0.5)" strokeWidth={1.8} />
          <Text
            className={resolved ? "flex-1 text-[13px] text-foreground/35 line-through" : "flex-1 text-[13px] text-foreground"}
            style={{ fontFamily: "Inter_500Medium" }}
            numberOfLines={2}
          >
            {card.title}
          </Text>
          <View style={styles.badge}>
            {resolved ? (
              <CheckCircle2 size={15} color="rgba(34,197,94,0.6)" />
            ) : runUi === "processing" ? (
              <ActivityIndicator size="small" color="#f59e0b" />
            ) : runUi === "needs_input" ? (
              <Pulse>
                <CircleAlert size={15} color="#f59e0b" />
              </Pulse>
            ) : runUi === "ready" ? (
              <CheckCircle2 size={15} color="#22c55e" />
            ) : runUi === "failed" ? (
              <XCircle size={15} color="#f43f5e" />
            ) : (
              <Circle size={15} color="#fb7185" fill="#fb7185" />
            )}
          </View>
        </View>
        <View style={styles.rowBottom}>
          <Text className="flex-1 text-[11px] text-foreground/40" numberOfLines={1} style={{ fontFamily: "Inter_400Regular" }}>
            {previewText}
          </Text>
          <Text className="text-[10px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            {formatTime(entry.runCompletedAt)}
          </Text>
        </View>
      </GlassCard>
    </Pressable>
  );
}

export default function TasksScreen({
  headerProps,
  onOpenChat,
}: {
  headerProps: HeaderProps;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
}) {
  const { cards, loading } = useCardsQuery();
  const [detail, setDetail] = useState<VisibleCardEntry | null>(null);

  // 历史列表是服务端真相视图：dismiss/snooze 不立即移除行，靠下次轮询把
  // latestOutcome 翻成 resolved（strikethrough）。所以 onHide 传 noop。
  const actions = useCardActions({
    onOpenChat,
    onHide: () => {},
    onClose: () => setDetail(null),
  });

  const groups = new Map<string, VisibleCardEntry[]>();
  for (const entry of cards) {
    const label = formatDate(entry.runCompletedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }
  const sections = [...groups.entries()].map(([title, data]) => ({ title, data }));

  return (
    <View className="flex-1">
      <PageHeader title="Tasks" subtitle="AI is running these for you" {...headerProps} />
      <SectionList
        className="flex-1 px-5"
        sections={sections}
        keyExtractor={(e) => `${e.runId}-${e.card.id}`}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text
            className="mb-2 mt-3 text-[11px] tracking-[1.5px] text-muted-foreground"
            style={{ fontFamily: "Inter_600SemiBold" }}
          >
            {section.title.toUpperCase()}
          </Text>
        )}
        renderItem={({ item }) => (
          <Row
            entry={item}
            onOpenChat={(card) => onOpenChat(card, "")}
            onOpenDetail={setDetail}
          />
        )}
        contentContainerClassName="pb-10"
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color="#71717a" style={{ marginTop: 60 }} />
          ) : (
            <View className="items-center pt-16 gap-2">
              <Sparkles size={28} color="rgba(0,0,0,0.35)" strokeWidth={1.5} />
              <Text className="text-[15px] text-foreground/60" style={{ fontFamily: "Inter_600SemiBold" }}>
                No cards yet
              </Text>
              <Text className="max-w-[260px] text-center text-[13px] leading-5 text-foreground/40" style={{ fontFamily: "Inter_400Regular" }}>
                Generate intent cards from the NOW tab. All cards will appear here.
              </Text>
            </View>
          )
        }
      />
      <CardDetailSheet
        entry={detail}
        onClose={() => setDetail(null)}
        onConfirm={actions.confirm}
        onSteer={actions.steer}
        onSnooze={actions.snooze}
        onDismiss={actions.dismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
});
