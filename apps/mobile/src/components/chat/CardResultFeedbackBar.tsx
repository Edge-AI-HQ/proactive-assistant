/**
 * Card chat 结果反馈条——web ui-web/chat/conversation/CardResultFeedbackBar 的
 * RN 介质版。AI 出最终结果后显示在 composer 上方：「Was this helpful?」+ 👍/👎
 * + Comment（text_feedback 学习信号，喂下一次生成，不发给 agent）+ Done（完成
 * 卡片 + 关闭会话）。👍/👎 走 buildAssistantMessageFeedbackBody（与气泡反馈同
 * 管线；messageId 未落库前为 null → 禁用到 chat:persisted 落 id）。web blur(16)
 * + 白底 0.5 → RN expo-blur + 白覆盖。
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { BlurView } from "expo-blur";
import { Check, MessageSquarePlus, Send, ThumbsDown, ThumbsUp } from "lucide-react-native";
import { buildAssistantMessageFeedbackBody, proxyPost } from "@pin-ai/core";

const FG = "29,33,48";

export default function CardResultFeedbackBar({
  messageId,
  channel,
  onComment,
  onDone,
  doneBusy,
}: {
  /** 末尾 assistant 结果消息 id；未落库时 null → 👍/👎 禁用。 */
  messageId: string | null;
  channel: string;
  onComment: (text: string) => void | Promise<void>;
  onDone: () => void;
  doneBusy: boolean;
}) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentSent, setCommentSent] = useState(false);

  const sendThumbs = useCallback(
    (next: "up" | "down") => {
      if (!messageId) return;
      const effective = feedback === next ? null : next;
      setFeedback(effective);
      const body = buildAssistantMessageFeedbackBody(messageId, effective, channel, "card_result_bar");
      if (!body) return;
      void proxyPost("/feedback", body).catch(() => {});
    },
    [feedback, messageId, channel],
  );

  const submitComment = useCallback(() => {
    const text = commentText.trim();
    if (!text) return;
    void Promise.resolve(onComment(text)).catch(() => {});
    setCommentText("");
    setCommentOpen(false);
    setCommentSent(true);
  }, [commentText, onComment]);

  const disabled = !messageId;

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <BlurView intensity={20} tint="light" style={[StyleSheet.absoluteFill, styles.blurRound]} />
        <View style={[StyleSheet.absoluteFill, styles.tint]} />
        <Text style={styles.prompt}>Was this helpful?</Text>
        <View style={styles.actions}>
          <Pressable
            onPress={() => sendThumbs("up")}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Helpful"
            style={[styles.iconBtn, feedback === "up" ? styles.upActive : styles.iconBtnIdle, disabled && styles.dim]}
          >
            <ThumbsUp size={13} strokeWidth={2} color={feedback === "up" ? "#16a34a" : `rgba(${FG},0.55)`} />
          </Pressable>
          <Pressable
            onPress={() => sendThumbs("down")}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Not helpful"
            style={[styles.iconBtn, feedback === "down" ? styles.downActive : styles.iconBtnIdle, disabled && styles.dim]}
          >
            <ThumbsDown size={13} strokeWidth={2} color={feedback === "down" ? "#dc2626" : `rgba(${FG},0.55)`} />
          </Pressable>
          <Pressable
            onPress={() => setCommentOpen((v) => !v)}
            disabled={commentSent}
            accessibilityRole="button"
            accessibilityLabel="Comment"
            style={[styles.commentBtn, commentSent && styles.dim]}
          >
            {commentSent ? (
              <Check size={12} strokeWidth={2.5} color={`rgba(${FG},0.65)`} />
            ) : (
              <MessageSquarePlus size={12} strokeWidth={2} color={`rgba(${FG},0.65)`} />
            )}
            <Text style={styles.commentLabel}>{commentSent ? "Sent" : "Comment"}</Text>
          </Pressable>
          <Pressable
            onPress={onDone}
            disabled={doneBusy}
            accessibilityRole="button"
            accessibilityLabel="Done"
            style={[styles.doneBtn, doneBusy && styles.dim]}
          >
            {doneBusy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Check size={13} strokeWidth={2.5} color="#fff" />
            )}
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        </View>
      </View>
      {commentOpen ? (
        <View style={styles.commentRow}>
          <TextInput
            value={commentText}
            onChangeText={setCommentText}
            onSubmitEditing={submitComment}
            placeholder="Add a comment…"
            placeholderTextColor={`rgba(${FG},0.35)`}
            style={styles.commentInput}
            returnKeyType="send"
          />
          <Pressable
            onPress={submitComment}
            disabled={!commentText.trim()}
            accessibilityRole="button"
            accessibilityLabel="Send feedback"
            style={[styles.sendBtn, !commentText.trim() && styles.dim]}
          >
            <Send size={14} strokeWidth={2} color="#fff" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingBottom: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  // expo-blur iOS 不跟随父级 overflow 裁圆角，borderRadius 直接给 BlurView + tint。
  tint: { backgroundColor: "rgba(255,255,255,0.5)", borderRadius: 16 },
  blurRound: { borderRadius: 16 },
  prompt: { fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.55)` },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  iconBtnIdle: { backgroundColor: `rgba(${FG},0.05)` },
  upActive: { backgroundColor: "rgba(34,197,94,0.2)" },
  downActive: { backgroundColor: "rgba(239,68,68,0.2)" },
  commentBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    backgroundColor: `rgba(${FG},0.05)`,
    marginLeft: 2,
  },
  commentLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.65)` },
  doneBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "#1d2130",
  },
  doneLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#fff" },
  dim: { opacity: 0.4 },
  commentRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  commentInput: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.1)`,
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 16,
    fontSize: 14,
    color: "#1d2130",
  },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#1d2130" },
});
