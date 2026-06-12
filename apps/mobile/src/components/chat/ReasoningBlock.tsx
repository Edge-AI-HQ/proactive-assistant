/**
 * "Thought" 折叠胶囊条——web ChatDetailView 的整行胶囊样式（✓ Thought
 * + chevron，玻璃条）：流式中标签 "Thinking…"（shimmer 扫光，web
 * ShimmerText 同款），完成态 "✓ Thought"；点击展开灰斜体思考全文。
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";

import { ShimmerText } from "../../ui/ShimmerText";

export default function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.pill}>
        {streaming ? null : <Check size={13} color="#71717a" strokeWidth={2.2} />}
        {streaming ? (
          <ShimmerText text="Thinking…" style={styles.label} />
        ) : (
          <Text style={styles.label}>Thought</Text>
        )}
        <View style={styles.spacer} />
        {expanded ? (
          <ChevronUp size={14} color="#a1a1aa" strokeWidth={1.8} />
        ) : (
          <ChevronDown size={14} color="#a1a1aa" strokeWidth={1.8} />
        )}
      </Pressable>
      {expanded ? <Text style={styles.text}>{text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.6)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.7)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  label: { fontSize: 13.5, color: "#52525b", fontFamily: "Inter_500Medium" },
  spacer: { flex: 1 },
  text: {
    marginTop: 8,
    paddingHorizontal: 4,
    fontSize: 13,
    color: "#a1a1aa",
    fontStyle: "italic",
    lineHeight: 19,
    fontFamily: "Inter_400Regular",
  },
});
