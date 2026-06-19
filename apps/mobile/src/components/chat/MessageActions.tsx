/**
 * Assistant 回复下的操作行——web 的 复制/👍/👎 对应物。copy 走
 * expo-clipboard；thumbs 走 core buildAssistantMessageFeedbackBody →
 * best-effort POST /feedback（与 web ConversationView 同源，清空 toggle 不发事件）。
 */
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Copy, ThumbsDown, ThumbsUp } from "lucide-react-native";
import { buildAssistantMessageFeedbackBody, proxyPost } from "@pin-ai/core";

export default function MessageActions({
  text,
  messageId,
  channel,
}: {
  text: string;
  messageId: string;
  channel: string;
}) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  const vote = (v: "up" | "down") => {
    const effective = voted === v ? null : v;
    setVoted(effective);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // clearing the toggle (effective=null) yields no event — body is null.
    const body = buildAssistantMessageFeedbackBody(messageId, effective, channel);
    if (body) void proxyPost("/feedback", body).catch(() => {});
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
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8, paddingLeft: 2 },
});
