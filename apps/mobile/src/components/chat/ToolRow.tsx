/**
 * 工具调用行——web 工具树的 RN 精简版：状态徽标（运行 spinner / ✓ / ✗）
 * + 工具名 + subagent 归属缩进（parentTaskId）与 agent 标签。
 */
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { ConversationContentPart } from "@pin-ai/core";

import { resolveToolPresentation } from "./tool-presentation";

type ToolPart = Extract<ConversationContentPart, { type: "tool-call" }>;

export default function ToolRow({ part, running }: { part: ToolPart; running: boolean }) {
  const done = part.result !== undefined;
  const failed = part.isError === true;
  const nested = !!part.parentTaskId;
  const { Icon, verb } = resolveToolPresentation(part.toolName);
  return (
    <View style={[styles.row, nested && styles.nested]}>
      {!done && running ? (
        <ActivityIndicator size="small" color="#a1a1aa" style={styles.badge} />
      ) : (
        <Text style={[styles.badge, styles.badgeText, failed && styles.failedText]}>
          {failed ? "✗" : done ? "✓" : "·"}
        </Text>
      )}
      <Icon size={12} color="#71717a" strokeWidth={1.8} style={styles.toolIcon} />
      <Text style={styles.name} numberOfLines={1}>
        {verb}
        {part.agentName ? <Text style={styles.agent}>  {part.agentName}</Text> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginTop: 5 },
  nested: { marginLeft: 18 },
  badge: { width: 18, marginRight: 4 },
  toolIcon: { marginRight: 4 },
  badgeText: { fontSize: 13, color: "#16a34a", textAlign: "center" },
  failedText: { color: "#dc2626" },
  name: { flex: 1, fontSize: 13, color: "#71717a" },
  agent: { fontSize: 11, color: "#a1a1aa" },
});
