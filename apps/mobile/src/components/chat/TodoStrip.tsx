/**
 * Turn-scoped todo 进度条——web TodoPanel 的 RN 轻量版：当前进行项 +
 * n/m 进度，点击展开全列表。数据源 @pin-ai/state 的 useTodoPlan（与
 * web 同一 store，write_todos 工具流驱动）。
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useTodoPlan } from "@pin-ai/state";

export default function TodoStrip({ sessionKey }: { sessionKey: string }) {
  const { t } = useTranslation("chat");
  const plan = useTodoPlan(sessionKey);
  const [expanded, setExpanded] = useState(false);
  if (!plan || plan.todos.length === 0) return null;

  const doneCount = plan.todos.filter((t) => t.status === "completed").length;
  const current = plan.todos.find((t) => t.status === "in_progress") ?? plan.todos[doneCount];

  return (
    <Pressable style={styles.strip} onPress={() => setExpanded((v) => !v)}>
      <View style={styles.header}>
        <Text style={styles.progress}>
          {t("todoPanel.progress", { completed: doneCount, total: plan.todos.length })}
        </Text>
        <Text style={styles.current} numberOfLines={1}>
          {current ? current.content : t("todoPanel.planDone")}
        </Text>
        <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
      </View>
      {expanded
        ? plan.todos.map((t, i) => (
            <Text
              key={i}
              style={[
                styles.item,
                t.status === "completed" && styles.done,
                t.status === "in_progress" && styles.active,
              ]}
              numberOfLines={1}
            >
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"} {t.content}
            </Text>
          ))
        : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    marginHorizontal: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "#eef2ff",
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  progress: { fontSize: 12, fontWeight: "700", color: "#4338ca" },
  current: { flex: 1, fontSize: 13, color: "#3730a3" },
  chevron: { fontSize: 12, color: "#6366f1" },
  item: { marginTop: 4, fontSize: 12, color: "#6366f1" },
  done: { color: "#a5b4fc", textDecorationLine: "line-through" },
  active: { fontWeight: "600" },
});
