/**
 * Assistant 回复下的操作行——web AssistantEntry 的 AssistantActionBar 对应物
 * (复制/👍/👎)。copy 走 expo-clipboard;thumbs 写 pai_feedback_events,键是后端
 * pai_chat_messages id——所以只有 entry 带上真实(纯数字)serverId 才显示按钮:
 * live turn 在 chat:done 后经 `chat:persisted` 帧补上 id,历史 turn 自带。
 * (与 web 同源门控:`/^\d+$/`;流式临时 id "turn-N" 一律不发。)
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
  /** 后端消息 id(entry.serverId ?? "")——非纯数字时 👍/👎 不渲染。 */
  messageId: string;
  channel: string;
}) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const hasBackendId = /^\d+$/.test(messageId);

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
      {text ? (
        <Pressable
          hitSlop={8}
          onPress={() => {
            void Clipboard.setStringAsync(text);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }}
        >
          <Copy size={14} color="#a1a1aa" strokeWidth={1.8} />
        </Pressable>
      ) : null}
      {hasBackendId ? (
        <>
          <Pressable hitSlop={8} onPress={() => vote("up")}>
            <ThumbsUp size={14} color={voted === "up" ? "#16a34a" : "#a1a1aa"} strokeWidth={1.8} />
          </Pressable>
          <Pressable hitSlop={8} onPress={() => vote("down")}>
            <ThumbsDown size={14} color={voted === "down" ? "#dc2626" : "#a1a1aa"} strokeWidth={1.8} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8, paddingLeft: 2 },
});
