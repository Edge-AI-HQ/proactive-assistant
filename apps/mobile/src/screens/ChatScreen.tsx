/**
 * Main chat（RN 第一刀）——「分层投资在 RN 兑现」的证明点：业务运行时
 * 100% 复用 @pin-ai/state 的 useConversationRuntime（SSE 流、转录合并、
 * 重连游标、HITL 状态全部共用），本文件只有 RN 渲染层（FlatList +
 * composer），不重新实现任何协议逻辑。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
import { Mic, SendHorizontal, Square } from "lucide-react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeInDown } from "react-native-reanimated";
import {
  cardActionFeedbackBody,
  conversationInit,
  deriveCardResultMessageId,
  feedbackChannelForSession,
  segmentAssistantParts,
  textFeedbackBody,
  type ConversationEntry,
  type HitlRequiresAction,
  type IntentCard,
} from "@pin-ai/core";
import { useConversationRuntime } from "@pin-ai/state";

import AiSphere from "../ui/AiSphere";
import { ShimmerText } from "../ui/ShimmerText";
import MarkdownText from "../components/chat/MarkdownText";
import MessageActions from "../components/chat/MessageActions";
import UserEntry from "../components/chat/UserEntry";
import TodoStrip from "../components/chat/TodoStrip";
import WorkGroup, { SpecialCard } from "../components/chat/WorkGroup";
import ProposeActionCard from "../components/chat/ProposeActionCard";
import CardResultFeedbackBar from "../components/chat/CardResultFeedbackBar";

import { notifyThreadActivity, readLocalHistory } from "../lib/sync/sync-bootstrap";
import { postCardFeedback } from "../hooks/useCardActions";

/** memo 边界：流式时只有正在更新的 entry 重渲（runtime reducer 不可变
 *  更新，未变 entry 保持引用同一；回调用 ref-latest 保持身份稳定）。 */
const Entry = memo(function Entry({
  entry,
  channel,
  onRetry,
  onUpdateQueued,
  onDeleteQueued,
  onSendNow,
  onReply,
  busy,
}: {
  entry: ConversationEntry;
  channel: string;
  onRetry: (id: string, text: string) => void;
  onUpdateQueued: (id: string, text: string) => void;
  onDeleteQueued: (id: string) => void;
  onSendNow: (id: string) => void;
  onReply: (text: string) => void;
  busy: boolean;
}) {
  // 行入场 = web 消息卡 initial{opacity:0,y:6} 0.26s 的对应物。
  if (entry.kind === "user") {
    return (
      <Animated.View entering={FadeInDown.duration(260)}>
        <UserEntry
          entry={entry}
          onRetry={onRetry}
          onUpdateQueued={onUpdateQueued}
          onDeleteQueued={onDeleteQueued}
          onSendNow={onSendNow}
        />
      </Animated.View>
    );
  }
  if (entry.kind === "assistant") {
    const fullText = entry.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n");
    return (
      <Animated.View style={styles.assistantRow} entering={FadeInDown.duration(260)}>
        {segmentAssistantParts(entry.parts).map((seg) =>
          seg.kind === "text" ? (
            <MarkdownText key={seg.key} text={seg.text} />
          ) : seg.kind === "group" ? (
            <WorkGroup key={seg.key} group={seg.group} streamingTail={entry.running} />
          ) : seg.part.toolName === "propose_action" ? (
            <ProposeActionCard key={seg.key} args={seg.part.args} onReply={onReply} busy={busy} />
          ) : (
            <SpecialCard key={seg.key} part={seg.part} />
          ),
        )}
        {entry.running && entry.parts.length === 0 ? (
          <View style={styles.thinkingPill}>
            <ShimmerText text="Thinking…" style={styles.thinkingText} />
          </View>
        ) : null}
        {!entry.running && fullText ? (
          <MessageActions
            text={fullText}
            messageId={entry.id}
            channel={channel}
          />
        ) : null}
      </Animated.View>
    );
  }
  return null; // heartbeat：debug-only，不渲染
});

export interface ChatScreenProps {
  /** main = 用户单例主对话；card = 卡片执行 thread。 */
  kind: "main" | "card";
  cardId?: string;
  /** 进入后自动作为首条用户消息发出（confirm/steer 的 agent 指令）。 */
  bootstrap?: string;
  /** card 模式：卡片本体——驱动底部结果反馈条（Was this helpful? + Comment + Done）。 */
  card?: IntentCard;
  /** card 模式：结果条 Done 完成卡片后关闭会话（= CardChatScreen onClose）。 */
  onCardClose?: () => void;
  /** card 满屏 sheet：底部 home-indicator 安全区，垫高 composer。 */
  bottomInset?: number;
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

export default function ChatScreen({ kind, cardId, bootstrap, card, onCardClose, bottomInset }: ChatScreenProps) {
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
      card={card}
      onCardClose={onCardClose}
      bottomInset={bottomInset}
    />
  );
}

function Conversation({
  sessionKey,
  bootstrap,
  draft,
  setDraft,
  listRef,
  card,
  onCardClose,
  bottomInset,
}: {
  sessionKey: string;
  bootstrap?: string;
  draft: string;
  setDraft: (s: string) => void;
  listRef: React.RefObject<FlatList<ConversationEntry> | null>;
  card?: IntentCard;
  onCardClose?: () => void;
  bottomInset?: number;
}) {
  const {
    transcript,
    ready,
    busy,
    sendMessage,
    stop,
    connection,
    retryMessage,
    updateQueuedMessage,
    deleteQueuedMessage,
    interruptQueuedMessage,
    awaitingDecision,
    submitDecision,
    threadId,
  } = useConversationRuntime({
    session: sessionKey,
    bootstrap,
    // 与 web 同一根门铃/本地优先注入——RN 的同步引擎吃同一套 core。
    onTurnPersisted: notifyThreadActivity,
    localHistory: readLocalHistory,
  });

  const visible = transcript;

  const channel = feedbackChannelForSession(sessionKey);

  // card 模式结果条：末尾 assistant turn 已结束、有可见文本、无 propose_action 时
  // 显示（core 纯 transcript 规则；messageId 未落库前 null → 👍/👎 禁用）。
  const [doneBusy, setDoneBusy] = useState(false);
  const cardResultMessageId = card ? deriveCardResultMessageId(visible) : undefined;
  const handleComment = useCallback(
    (text: string) => {
      if (!card) return;
      void postCardFeedback(textFeedbackBody(card, text), `fb:text:${card.id}`);
    },
    [card],
  );
  const handleCardDone = useCallback(() => {
    if (!card) return;
    setDoneBusy(true);
    void postCardFeedback(cardActionFeedbackBody("complete", card), `fb:complete:${card.id}`);
    onCardClose?.();
  }, [card, onCardClose]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void sendMessage(text);
  }, [draft, busy, sendMessage, setDraft]);

  // ref-latest：给 memo(Entry) 稳定的回调身份（runtime 返回的函数身份
  // 不保证稳定，inline lambda 则每 render 必击穿 memo）。
  const retryRef = useRef(retryMessage);
  retryRef.current = retryMessage;
  const handleRetry = useCallback((id: string, text: string) => {
    void retryRef.current(id, text);
  }, []);
  // ref-latest（同 retry）：给 memo(Entry) 稳定的排队操作回调身份。
  const queuedRef = useRef({
    update: updateQueuedMessage,
    del: deleteQueuedMessage,
    interrupt: interruptQueuedMessage,
  });
  queuedRef.current = {
    update: updateQueuedMessage,
    del: deleteQueuedMessage,
    interrupt: interruptQueuedMessage,
  };
  const onUpdateQueued = useCallback((id: string, text: string) => void queuedRef.current.update(id, text), []);
  const onDeleteQueued = useCallback((id: string) => void queuedRef.current.del(id), []);
  const onSendNow = useCallback((id: string) => void queuedRef.current.interrupt(id), []);
  // ProposeActionCard 回复 = sendMessage（ref-latest 稳定身份给 memo(Entry)）。
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;
  const onReply = useCallback((text: string) => void sendRef.current(text), []);

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
          <Entry
            entry={item}
            channel={channel}
            onRetry={handleRetry}
            onUpdateQueued={onUpdateQueued}
            onDeleteQueued={onDeleteQueued}
            onSendNow={onSendNow}
            onReply={onReply}
            busy={busy}
          />
        )}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          ready ? (
            // web MinimalistLanding 同构：水晶球 + 引导文案。
            <View style={styles.emptyWrap}>
              <AiSphere size={216} mode="idle" />
              <Text style={styles.empty}>Ask PIN AI anything.</Text>
            </View>
          ) : (
            <ActivityIndicator color="#71717a" style={{ marginTop: 48 }} />
          )
        }
      />
      {threadId ? <TodoStrip sessionKey={threadId} /> : null}
      {awaitingDecision ? (
        <HitlBar
          key={awaitingDecision.toolUseId}
          action={awaitingDecision}
          onDecide={(decision) => void submitDecision(decision)}
        />
      ) : null}
      {card && cardResultMessageId !== undefined ? (
        <CardResultFeedbackBar
          messageId={cardResultMessageId}
          channel={channel}
          onComment={handleComment}
          onDone={handleCardDone}
          doneBusy={doneBusy}
        />
      ) : null}
      <View style={[styles.composer, bottomInset ? { paddingBottom: 12 + bottomInset } : null]}>
        {/* web composer 玻璃条（blur 16-20px + 半透底）的 RN 介质版。 */}
        <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.composerTint]} />
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message PIN AI…"
          placeholderTextColor="#a1a1aa"
          multiline
          editable
        />
        <View style={styles.composerIcons}>
          <Mic size={18} color="#a1a1aa" strokeWidth={1.8} />
          <Pressable
            style={({ pressed }) => [styles.sendButton, pressed && { opacity: 0.7 }]}
            onPress={busy ? () => void stop() : send}
            accessibilityRole="button"
            accessibilityLabel={busy ? "Stop" : "Send"}
          >
            {/* web 同款品红渐变 135° + 彩影（ConversationView 发送钮）。 */}
            <LinearGradient
              colors={["hsl(292, 78%, 63%)", "hsl(330, 80%, 65%)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            {busy ? (
              <Square size={14} color="#fff" fill="#fff" />
            ) : (
              <SendHorizontal size={16} color="#fff" strokeWidth={2} />
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // 透明：aurora 从容器透出（加载态短暂可见）。
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  connection: { textAlign: "center", paddingVertical: 4, fontSize: 12, color: "#a16207" },
  list: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 8 },
  emptyWrap: { alignItems: "center", marginTop: 48 },
  empty: { textAlign: "center", marginTop: 8, color: "#a1a1aa", fontSize: 15 },
  userRow: { alignItems: "flex-end", marginVertical: 6 },
  userBubble: {
    backgroundColor: "#1a1a1a",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "84%",
  },
  // Message content uses the system font so iOS can fall back to Apple Color Emoji.
  userText: { color: "#fff", fontSize: 16, lineHeight: 22 },
  failed: { color: "#fca5a5", fontSize: 12, marginTop: 4 },
  assistantRow: { marginVertical: 6, maxWidth: "92%" },
  assistantText: {
    color: "#1a1a1a",
    fontSize: 16,
    lineHeight: 23,
    marginTop: 4,
    fontFamily: "Geist_400Regular",
  },
  reasoning: { color: "#a1a1aa", fontSize: 13, fontStyle: "italic", lineHeight: 18, marginTop: 4 },
  toolCall: { color: "#71717a", fontSize: 13, marginTop: 4 },
  spinner: { alignSelf: "flex-start", marginTop: 6 },
  thinkingPill: { alignSelf: "flex-start", marginTop: 2, marginLeft: -2, paddingVertical: 2 },
  thinkingText: { fontSize: 15, fontFamily: "Inter_500Medium", color: "rgba(29,33,48,0.65)" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(228,228,231,0.6)",
    overflow: "hidden",
  },
  composerTint: { backgroundColor: "rgba(250,249,247,0.55)" },
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
    borderRadius: 19,
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "0 4px 12px hsla(292, 78%, 63%, 0.35)",
  },
  composerIcons: { flexDirection: "row", alignItems: "center", gap: 10 },
  timestamp: { marginTop: 3, fontSize: 10, color: "#a1a1aa", textAlign: "right" },
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
