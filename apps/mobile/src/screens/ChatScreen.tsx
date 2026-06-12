/**
 * Main chat（RN 第一刀）——「分层投资在 RN 兑现」的证明点：业务运行时
 * 100% 复用 @pin-ai/state 的 useConversationRuntime（SSE 流、转录合并、
 * 重连游标、HITL 状态全部共用），本文件只有 RN 渲染层（FlatList +
 * composer），不重新实现任何协议逻辑。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  conversationInit,
  partsHaveNotifyUser,
  type ConversationContentPart,
  type ConversationEntry,
  type HitlRequiresAction,
} from "@pin-ai/core";
import { useConversationRuntime } from "@pin-ai/state";

import { notifyThreadActivity, readLocalHistory } from "../lib/sync/sync-bootstrap";

function Part({ part }: { part: ConversationContentPart }) {
  if (part.type === "text") {
    return part.text ? <Text style={styles.assistantText}>{part.text}</Text> : null;
  }
  if (part.type === "reasoning") {
    return part.text ? <Text style={styles.reasoning}>{part.text}</Text> : null;
  }
  // tool-call：一行工具名（完整 tool steps UI 是后续刀）。
  return <Text style={styles.toolCall}>⚙ {part.toolName}</Text>;
}

function Entry({
  entry,
  onRetry,
}: {
  entry: ConversationEntry;
  onRetry: (id: string, text: string) => void;
}) {
  if (entry.kind === "user") {
    return (
      <View style={styles.userRow}>
        <Pressable
          style={styles.userBubble}
          disabled={!entry.failed}
          onPress={() => onRetry(entry.id, entry.text)}
        >
          <Text style={styles.userText}>{entry.text}</Text>
          {entry.failed ? <Text style={styles.failed}>failed — tap to retry</Text> : null}
        </Pressable>
      </View>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <View style={styles.assistantRow}>
        {entry.parts.map((p, i) => (
          <Part key={i} part={p} />
        ))}
        {entry.running ? <ActivityIndicator size="small" color="#71717a" style={styles.spinner} /> : null}
      </View>
    );
  }
  return null; // heartbeat：debug-only，不渲染
}

export interface ChatScreenProps {
  /** main = 用户单例主对话；card = 卡片执行 thread。 */
  kind: "main" | "card";
  cardId?: string;
  /** 进入后自动作为首条用户消息发出（confirm/steer 的 agent 指令）。 */
  bootstrap?: string;
}

/** HITL 审批条：agent 暂停在 side-effect 工具上（chat:requires_action），
 *  approve/reject 后运行续流——web 的 HitlApprovalCard 的 RN 对应物。
 *  不渲染它 = 用户看不到暂停原因，流看起来「卡死」（真机实测的坑）。 */
function HitlBar({
  action,
  onDecide,
}: {
  action: HitlRequiresAction;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const decide = (decision: "approve" | "reject") => {
    setSubmitting(true);
    onDecide(decision);
  };
  return (
    <View style={styles.hitlBar}>
      <Text style={styles.hitlTitle}>PIN AI wants to run: {action.toolName}</Text>
      {action.argsPreview ? (
        <Text style={styles.hitlArgs} numberOfLines={3}>
          {action.argsPreview}
        </Text>
      ) : null}
      <View style={styles.hitlActions}>
        <Pressable
          style={[styles.hitlButton, styles.hitlApprove, submitting && styles.hitlDisabled]}
          disabled={submitting}
          onPress={() => decide("approve")}
        >
          <Text style={styles.hitlApproveText}>Approve</Text>
        </Pressable>
        <Pressable
          style={[styles.hitlButton, submitting && styles.hitlDisabled]}
          disabled={submitting}
          onPress={() => decide("reject")}
        >
          <Text style={styles.hitlRejectText}>Reject</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ChatScreen({ kind, cardId, bootstrap }: ChatScreenProps) {
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const listRef = useRef<FlatList<ConversationEntry>>(null);

  // thread 解析（与 web 同一 init 协议：main 单例 / card-thread-<cardId>）。
  useEffect(() => {
    let cancelled = false;
    void conversationInit(kind === "card" ? { kind, cardId } : { kind })
      .then((r) => {
        if (!cancelled) setSessionKey(r.sessionKey);
      })
      .catch((err) => console.error("[chat] init failed:", err));
    return () => {
      cancelled = true;
    };
  }, [kind, cardId]);

  if (sessionKey === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#71717a" />
      </View>
    );
  }
  return (
    <Conversation
      sessionKey={sessionKey}
      bootstrap={bootstrap}
      draft={draft}
      setDraft={setDraft}
      listRef={listRef}
    />
  );
}

function Conversation({
  sessionKey,
  bootstrap,
  draft,
  setDraft,
  listRef,
}: {
  sessionKey: string;
  bootstrap?: string;
  draft: string;
  setDraft: (s: string) => void;
  listRef: React.RefObject<FlatList<ConversationEntry> | null>;
}) {
  const {
    transcript,
    ready,
    busy,
    sendMessage,
    stop,
    connection,
    retryMessage,
    awaitingDecision,
    submitDecision,
  } = useConversationRuntime({
    session: sessionKey,
    bootstrap,
    // 与 web 同一根门铃/本地优先注入——RN 的同步引擎吃同一套 core。
    onTurnPersisted: notifyThreadActivity,
    localHistory: readLocalHistory,
  });

  // tick 触发的 assistant turn 默认隐藏（与 web 一致），notify_user 例外。
  const visible = useMemo(
    () =>
      transcript.filter((e) => {
        if (e.kind === "heartbeat") return false;
        if (e.kind === "assistant" && e.debug) return partsHaveNotifyUser(e.parts);
        return true;
      }),
    [transcript],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void sendMessage(text);
  }, [draft, busy, sendMessage, setDraft]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {connection === "reconnecting" ? (
        <Text style={styles.connection}>reconnecting…</Text>
      ) : null}
      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={visible}
        keyExtractor={(e) => `${e.kind}-${e.id}`}
        renderItem={({ item }) => (
          <Entry entry={item} onRetry={(id, text) => void retryMessage(id, text)} />
        )}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          ready ? (
            <Text style={styles.empty}>Ask PIN AI anything.</Text>
          ) : (
            <ActivityIndicator color="#71717a" style={{ marginTop: 48 }} />
          )
        }
      />
      {awaitingDecision ? (
        <HitlBar
          key={awaitingDecision.toolUseId}
          action={awaitingDecision}
          onDecide={(decision) => void submitDecision(decision)}
        />
      ) : null}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message PIN AI…"
          placeholderTextColor="#a1a1aa"
          multiline
          editable
        />
        <Pressable
          style={({ pressed }) => [styles.sendButton, pressed && { opacity: 0.7 }]}
          onPress={busy ? () => void stop() : send}
        >
          <Text style={styles.sendText}>{busy ? "Stop" : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f4f0" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f6f4f0" },
  connection: { textAlign: "center", paddingVertical: 4, fontSize: 12, color: "#a16207" },
  list: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 8 },
  empty: { textAlign: "center", marginTop: 64, color: "#a1a1aa", fontSize: 15 },
  userRow: { alignItems: "flex-end", marginVertical: 6 },
  userBubble: {
    backgroundColor: "#1a1a1a",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "84%",
  },
  userText: { color: "#fff", fontSize: 16, lineHeight: 22 },
  failed: { color: "#fca5a5", fontSize: 12, marginTop: 4 },
  assistantRow: { marginVertical: 6, maxWidth: "92%" },
  assistantText: { color: "#1a1a1a", fontSize: 16, lineHeight: 23, marginTop: 4 },
  reasoning: { color: "#a1a1aa", fontSize: 13, fontStyle: "italic", lineHeight: 18, marginTop: 4 },
  toolCall: { color: "#71717a", fontSize: 13, marginTop: 4 },
  spinner: { alignSelf: "flex-start", marginTop: 6 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e4e4e7",
    backgroundColor: "#faf9f7",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: "#fff",
    fontSize: 16,
    color: "#1a1a1a",
  },
  sendButton: {
    backgroundColor: "#1a1a1a",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  sendText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  hitlBar: {
    marginHorizontal: 12,
    marginBottom: 4,
    padding: 14,
    borderRadius: 16,
    backgroundColor: "#fffbeb",
    borderWidth: 1,
    borderColor: "#fde68a",
  },
  hitlTitle: { fontSize: 14, fontWeight: "600", color: "#92400e" },
  hitlArgs: { marginTop: 6, fontSize: 12, color: "#78716c", fontFamily: "Menlo" },
  hitlActions: { flexDirection: "row", gap: 8, marginTop: 10 },
  hitlButton: {
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 18,
    backgroundColor: "#f4f4f5",
  },
  hitlApprove: { backgroundColor: "#1a1a1a" },
  hitlApproveText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  hitlRejectText: { color: "#3f3f46", fontSize: 14, fontWeight: "500" },
  hitlDisabled: { opacity: 0.5 },
});
