/**
 * Tasks 视图：全量卡片时间线（含已处理的——与 NOW 的区别是不过滤
 * outcome，显示状态标签）。数据同源 useCardsQuery。
 */
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { CardOutcome, VisibleCardEntry } from "@pin-ai/core";
import { useCardsQuery } from "@pin-ai/state";

const OUTCOME_LABELS: Record<CardOutcome, { label: string; color: string }> = {
  confirm: { label: "Confirmed", color: "#16a34a" },
  modify: { label: "Steered", color: "#2563eb" },
  complete: { label: "Done", color: "#16a34a" },
  dismiss: { label: "Dismissed", color: "#a1a1aa" },
  snooze: { label: "Snoozed", color: "#ca8a04" },
};

function Row({ entry }: { entry: VisibleCardEntry }) {
  const outcome = entry.latestOutcome ? OUTCOME_LABELS[entry.latestOutcome] : null;
  const when = entry.runCompletedAt ? new Date(entry.runCompletedAt).toLocaleDateString() : "";
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.title} numberOfLines={2}>
          {entry.card.title}
        </Text>
        {outcome ? (
          <Text style={[styles.outcome, { color: outcome.color }]}>{outcome.label}</Text>
        ) : (
          <Text style={[styles.outcome, { color: "#2563eb" }]}>Open</Text>
        )}
      </View>
      <Text style={styles.meta}>
        {entry.card.goalBasket} · {when}
      </Text>
    </View>
  );
}

export default function TasksScreen() {
  const { cards, loading, refresh } = useCardsQuery();
  return (
    <FlatList
      style={styles.root}
      contentContainerStyle={styles.content}
      data={cards}
      keyExtractor={(e) => e.card.id}
      renderItem={({ item }) => <Row entry={item} />}
      refreshControl={
        <RefreshControl refreshing={loading && cards.length > 0} onRefresh={() => void refresh()} />
      }
      ListEmptyComponent={
        <Text style={styles.empty}>{loading ? "Loading…" : "No cards yet."}</Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 8 },
  empty: { textAlign: "center", marginTop: 80, color: "#a1a1aa" },
  row: {
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowHead: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  title: { flex: 1, fontSize: 15, fontWeight: "500", color: "#1a1a1a", lineHeight: 20 },
  outcome: { fontSize: 12, fontWeight: "600" },
  meta: { marginTop: 4, fontSize: 12, color: "#a1a1aa", textTransform: "capitalize" },
});
