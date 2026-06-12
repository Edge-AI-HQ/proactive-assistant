/**
 * Assistant 回复下的操作行——web 的 复制/👍/👎/🔄 对应物。copy 走
 * expo-clipboard；regenerate 只在最后一条 assistant 上出现（runtime
 * regenerateLast 语义）；thumbs 触觉反馈 + 高亮（消息级 feedback 上报
 * 端点接入列 README 清单）。
 */
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Copy, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react-native";

export default function MessageActions({
  text,
  canRegenerate,
  onRegenerate,
}: {
  text: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  const vote = (v: "up" | "down") => {
    setVoted((prev) => (prev === v ? null : v));
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <View style={styles.row}>
      <Pressable
        hitSlop={8}
        onPress={() => {
          void Clipboard.setStringAsync(text);
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }}
      >
        <Copy size={14} color="#a1a1aa" strokeWidth={1.8} />
      </Pressable>
      <Pressable hitSlop={8} onPress={() => vote("up")}>
        <ThumbsUp size={14} color={voted === "up" ? "#16a34a" : "#a1a1aa"} strokeWidth={1.8} />
      </Pressable>
      <Pressable hitSlop={8} onPress={() => vote("down")}>
        <ThumbsDown size={14} color={voted === "down" ? "#dc2626" : "#a1a1aa"} strokeWidth={1.8} />
      </Pressable>
      {canRegenerate ? (
        <Pressable hitSlop={8} onPress={onRegenerate}>
          <RotateCcw size={14} color="#a1a1aa" strokeWidth={1.8} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8, paddingLeft: 2 },
});
