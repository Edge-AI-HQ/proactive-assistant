/**
 * TASKS 页——web CardTimeline 的 RN 对应物（UI 刀 3）：日期分组
 * （Today/Yesterday/Mon d）+ 玻璃行（标题 + 状态环 + previewText +
 * 时间）。状态语义来自 core deriveCardUiStatus（服务端 runStatus 真相
 * 源；RN 无 web 的乐观 id 集，resolved 由 latestOutcome 派生——同一
 * 服务端语义）。
 */
import { SectionList, Pressable, StyleSheet, Text, View, ActivityIndicator } from "react-native";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Sparkles,
  XCircle,
} from "lucide-react-native";
import {
  deriveCardUiStatus,
  isReminderCard,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardsQuery } from "@pin-ai/state";

import PageHeader from "../components/app/PageHeader";
import { GlassCard } from "../ui/GlassCard";
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

function Row({ entry, onPress }: { entry: VisibleCardEntry; onPress: () => void }) {
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
      : card.sources.join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={onPress}
    >
      <GlassCard className="mb-2 px-3.5 py-3.5">
        <View style={styles.rowTop}>
          <Text
            className={resolved ? "flex-1 text-[13px] text-foreground/35 line-through" : "flex-1 text-[13px] text-foreground"}
            style={{ fontFamily: "Inter_500Medium" }}
            numberOfLines={1}
          >
            {card.title}
          </Text>
          <View style={styles.badge}>
            {resolved ? (
              <CheckCircle2 size={15} color="rgba(34,197,94,0.6)" />
            ) : runUi === "processing" ? (
              <ActivityIndicator size="small" color="#f59e0b" />
            ) : runUi === "needs_input" ? (
              <CircleAlert size={15} color="#f59e0b" />
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
  onOpenCard,
}: {
  headerProps: HeaderProps;
  onOpenCard: (card: IntentCard) => void;
}) {
  const { cards, loading } = useCardsQuery();

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
        renderItem={({ item }) => <Row entry={item} onPress={() => onOpenCard(item.card)} />}
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
    </View>
  );
}

const styles = StyleSheet.create({
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  badge: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
});
