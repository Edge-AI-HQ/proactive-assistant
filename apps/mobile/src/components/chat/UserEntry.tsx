/**
 * 用户消息气泡——web ui-web/chat/conversation/UserEntry 的 RN 介质版。右对齐深色
 * 气泡 + 气泡下方操作行，按状态分四态（对齐 web）：
 *   sent     → 时间戳 + Copy
 *   queued   → 「Queued」徽章 + Edit / Send-Now / Delete（排队消息在 worker 认领前
 *              可改/删/插队；逻辑层 updateQueued/deleteQueued/interruptQueued 复用
 *              @pin-ai/state，本组件只渲染 + 调）
 *   editing  → 行内 TextInput + Save / Cancel
 *   failed   → 红「Not sent · Retry」
 * web hover 出操作行 → RN 触屏常显小按钮（触屏无 hover）。
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { AlertCircle, Check, Copy, Pencil, RotateCcw, Send, Trash2, X } from "lucide-react-native";
import type { ConversationEntry } from "@pin-ai/core";

type UserEntryData = Extract<ConversationEntry, { kind: "user" }>;

const FG = "29,33,48";

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function UserEntry({
  entry,
  onRetry,
  onUpdateQueued,
  onDeleteQueued,
  onSendNow,
}: {
  entry: UserEntryData;
  onRetry: (id: string, text: string) => void;
  onUpdateQueued: (id: string, text: string) => void;
  onDeleteQueued: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const isQueued = !!entry.queued;

  const copy = async () => {
    await Clipboard.setStringAsync(entry.text);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const saveEdit = () => {
    const t = draft.trim();
    if (t && t !== entry.text) onUpdateQueued(entry.id, t);
    setEditing(false);
  };
  const cancelEdit = () => {
    setDraft(entry.text);
    setEditing(false);
  };

  return (
    <View style={styles.wrap}>
      <View style={[styles.bubble, entry.failed && styles.faded, editing && styles.bubbleWide]}>
        {editing ? (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            style={styles.editInput}
            placeholderTextColor="rgba(255,255,255,0.5)"
          />
        ) : (
          <Text style={styles.text}>{entry.text}</Text>
        )}
      </View>

      {entry.failed ? (
        <Pressable
          style={styles.failRow}
          onPress={() => onRetry(entry.id, entry.text)}
          accessibilityRole="button"
          accessibilityLabel="Retry sending"
        >
          <AlertCircle size={11} color="#ef4444" strokeWidth={2} />
          <Text style={styles.failText}>Not sent</Text>
          <Text style={styles.failDot}>·</Text>
          <RotateCcw size={10} color="#ef4444" strokeWidth={2} />
          <Text style={styles.failText}>Retry</Text>
        </Pressable>
      ) : (
        <View style={styles.actions}>
          {isQueued ? (
            <View style={styles.queuedBadge}>
              <Text style={styles.queuedText}>Queued</Text>
            </View>
          ) : (
            <Text style={styles.time}>{clockTime(entry.ts)}</Text>
          )}

          {!isQueued ? (
            <Pressable onPress={copy} style={styles.actBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Copy">
              {copied ? (
                <Check size={13} color="#059669" strokeWidth={2} />
              ) : (
                <Copy size={13} color={`rgba(${FG},0.4)`} strokeWidth={1.8} />
              )}
            </Pressable>
          ) : editing ? (
            <>
              <Pressable onPress={saveEdit} style={styles.actBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Save">
                <Check size={13} color={`rgba(${FG},0.6)`} strokeWidth={2} />
              </Pressable>
              <Pressable onPress={cancelEdit} style={styles.actBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Cancel">
                <X size={13} color={`rgba(${FG},0.6)`} strokeWidth={2} />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable onPress={() => setEditing(true)} style={styles.actBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Edit">
                <Pencil size={12} color={`rgba(${FG},0.4)`} strokeWidth={1.8} />
              </Pressable>
              <Pressable onPress={() => onSendNow(entry.id)} style={styles.actBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Send now">
                <Send size={12} color={`rgba(${FG},0.4)`} strokeWidth={1.8} />
              </Pressable>
              <Pressable onPress={() => onDeleteQueued(entry.id)} style={styles.actBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Delete">
                <Trash2 size={12} color={`rgba(${FG},0.4)`} strokeWidth={1.8} />
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end", marginVertical: 6 },
  bubble: {
    backgroundColor: "#1a1a1a",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "84%",
  },
  bubbleWide: { width: "84%" },
  faded: { opacity: 0.5 },
  // web user 气泡 = text-bodySm（@pin-ai/design bodySm = 13px）leading-relaxed。
  text: { color: "#fff", fontSize: 13, lineHeight: 20 },
  editInput: { color: "#fff", fontSize: 13, lineHeight: 20, minHeight: 44, maxHeight: 120, padding: 0 },
  actions: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, paddingRight: 2 },
  time: { fontSize: 11, color: `rgba(${FG},0.4)`, fontFamily: "Inter_500Medium" },
  queuedBadge: { borderRadius: 999, backgroundColor: `rgba(${FG},0.06)`, paddingHorizontal: 8, paddingVertical: 2 },
  queuedText: { fontSize: 11, color: `rgba(${FG},0.45)`, fontFamily: "Inter_500Medium" },
  actBtn: { width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  failRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  failText: { fontSize: 12, color: "#ef4444", fontFamily: "Inter_500Medium" },
  failDot: { fontSize: 12, color: "#ef4444" },
});
