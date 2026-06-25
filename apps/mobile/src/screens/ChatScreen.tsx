/**
 * Main chat（RN 第一刀）——「分层投资在 RN 兑现」的证明点：业务运行时
 * 100% 复用 @pin-ai/state 的 useConversationRuntime（SSE 流、转录合并、
 * 重连游标、HITL 状态全部共用），本文件只有 RN 渲染层（FlatList +
 * composer），不重新实现任何协议逻辑。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Check, X } from "lucide-react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import {
  cardActionFeedbackBody,
  conversationInit,
  deriveCardResultMessageId,
  feedbackChannelForSession,
  findHitlHostId,
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
import ChatComposer from "../components/chat/ChatComposer";
import { VoiceButton } from "../voice";

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
  hitlAction,
  onDecide,
}: {
  entry: ConversationEntry;
  channel: string;
  onRetry: (id: string, text: string) => void;
  onUpdateQueued: (id: string, text: string) => void;
  onDeleteQueued: (id: string) => void;
  onSendNow: (id: string) => void;
  onReply: (text: string) => void;
  busy: boolean;
  hitlAction?: HitlRequiresAction | null;
  onDecide?: (decision: "approve" | "reject", message?: string) => void;
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
    const showHitl = !!hitlAction && !!onDecide;
    const segments = segmentAssistantParts(entry.parts);
    return (
      <Animated.View style={styles.assistantRow} entering={FadeInDown.duration(260)}>
        {segments.map((seg, idx) =>
          seg.kind === "text" ? (
            <MarkdownText key={seg.key} text={seg.text} />
          ) : seg.kind === "group" ? (
            <WorkGroup
              key={seg.key}
              group={seg.group}
              streamingTail={entry.running && idx === segments.length - 1}
            />
          ) : seg.part.toolName === "propose_action" ? (
            <ProposeActionCard key={seg.key} args={seg.part.args} onReply={onReply} busy={busy} />
          ) : (
            <SpecialCard key={seg.key} part={seg.part} />
          ),
        )}
        {entry.running && entry.parts.length === 0 && !showHitl ? (
          <View style={styles.thinkingPill}>
            <ShimmerText text="Thinking…" style={styles.thinkingText} />
          </View>
        ) : null}
        {showHitl ? (
          <View style={styles.hitlInlineWrap}>
            <HitlApprovalCard
              action={hitlAction}
              disabled={busy}
              onDecide={onDecide}
            />
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

/** Turn an upper/snake-case tool or SaaS slug into readable sentence case:
 *  `GMAIL_SEND_DRAFT` → `Gmail send draft`. Mirrors ui-web HitlApprovalCard. */
function humanizeSlug(slug: string): string {
  const s = slug.replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : slug;
}

/** Turn a paused side-effect tool call into human-friendly card copy so the
 *  user sees an action, not the internal Composio meta-tool JSON. */
function describeApproval(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsPreview: string | undefined,
): { title: string; detail?: string } {
  const a = args ?? {};

  switch (toolName) {
    case "preference_add": {
      const statement = typeof a.statement === "string" ? a.statement : undefined;
      return { title: "Save a preference", detail: statement ?? argsPreview };
    }
    case "COMPOSIO_MULTI_EXECUTE_TOOL": {
      const calls = Array.isArray(a.calls) ? a.calls : [];
      const actions = calls
        .map((c) =>
          c && typeof c === "object"
            ? (c as Record<string, unknown>).tool_slug
            : undefined,
        )
        .filter((s): s is string => typeof s === "string")
        .map(humanizeSlug);
      if (actions.length === 0) return { title: "Run an action", detail: argsPreview };
      if (actions.length === 1) return { title: actions[0] };
      return {
        title: `Run ${actions.length} actions`,
        detail: actions.map((s) => `• ${s}`).join("\n"),
      };
    }
    default:
      return { title: humanizeSlug(toolName), detail: argsPreview };
  }
}

/** HITL 审批卡：RN 对齐 packages/ui-web/src/chat/conversation/HitlApprovalCard.tsx。 */
function HitlApprovalCard({
  action,
  disabled,
  onDecide,
}: {
  action: HitlRequiresAction;
  disabled: boolean;
  onDecide: (decision: "approve" | "reject", message?: string) => void;
}) {
  const allowed = action.allowedDecisions;
  const canReject = allowed.length === 0 || allowed.includes("reject");
  const canApprove = allowed.length === 0 || allowed.includes("approve");
  const { title, detail } = describeApproval(action.toolName, action.args, action.argsPreview);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const decide = (decision: "approve" | "reject", message?: string) => {
    setSubmitting(true);
    onDecide(decision, message);
  };
  return (
    <View style={styles.hitlCard}>
      <View style={styles.hitlHeader}>
        <View style={styles.hitlIconBox}>
          <Text style={styles.hitlIcon}>⚠️</Text>
        </View>
        <View style={styles.hitlHeaderCopy}>
          <Text style={styles.hitlKicker}>NEEDS YOUR APPROVAL</Text>
          <Text style={styles.hitlTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
      </View>

      {detail ? (
        <View style={styles.hitlDetailWrap}>
          <Text style={styles.hitlDetail}>{detail}</Text>
        </View>
      ) : null}

      {rejecting ? (
        <View style={styles.hitlRejectPanel}>
          <View style={styles.hitlReasonInputRow}>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Optional: tell the agent why (it continues without running the tool)"
              placeholderTextColor="rgba(29,33,48,0.35)"
              editable={!disabled && !submitting}
              multiline
              style={styles.hitlReasonInput}
            />
            <VoiceButton prefill={reason} onUpdate={setReason} disabled={disabled || submitting} />
          </View>
          <View style={styles.hitlRejectActions}>
            <Pressable
              style={[styles.hitlButton, styles.hitlGhostButton, (disabled || submitting) && styles.hitlDisabled]}
              disabled={disabled || submitting}
              onPress={() => {
                setRejecting(false);
                setReason("");
              }}
            >
              <Text style={styles.hitlRejectText}>Back</Text>
            </Pressable>
            <Pressable
              style={[styles.hitlButton, styles.hitlDangerButton, (disabled || submitting) && styles.hitlDisabled]}
              disabled={disabled || submitting}
              onPress={() => decide("reject", reason.trim() || undefined)}
            >
              <Text style={styles.hitlApproveText}>Reject</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={[styles.hitlActions, styles.hitlActionBar]}>
          {canReject ? (
            <Pressable
              style={[styles.hitlButton, styles.hitlGhostButton, (disabled || submitting) && styles.hitlDisabled]}
              disabled={disabled || submitting}
              onPress={() => setRejecting(true)}
            >
              <X size={14} color="#1d2130" strokeWidth={2} />
              <Text style={styles.hitlRejectText}>Reject</Text>
            </Pressable>
          ) : null}
          {canApprove ? (
            <Pressable
              style={[styles.hitlButton, styles.hitlApprove, (disabled || submitting) && styles.hitlDisabled]}
              disabled={disabled || submitting}
              onPress={() => decide("approve")}
            >
              <Check size={14} color="#fff" strokeWidth={2} />
              <Text style={styles.hitlApproveText}>Approve</Text>
            </Pressable>
          ) : null}
        </View>
      )}
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
    setDraft("");
    setSessionKey(null);
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
      key={sessionKey}
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
    // Card chat stays cloud-authoritative for now: opening one card must never
    // paint another card's stale SQLite rows. The doorbell below can still keep
    // SQLite warm for future offline/search use, but it is not a render source.
    localHistory: card ? undefined : readLocalHistory,
  });
  useEffect(() => {
    notifyThreadActivity(sessionKey);
  }, [sessionKey]);

  const visible = transcript;
  const hitlHostId = useMemo(
    () => findHitlHostId(visible, !!awaitingDecision),
    [awaitingDecision, visible],
  );

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

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setDraft("");
      await sendMessage(trimmed);
    },
    [sendMessage, setDraft],
  );

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
            hitlAction={item.kind === "assistant" && item.id === hitlHostId ? awaitingDecision : null}
            onDecide={(decision, message) => void submitDecision(decision, message)}
          />
        )}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
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
      {awaitingDecision && !hitlHostId ? (
        <View style={styles.hitlFallbackWrap}>
          <HitlApprovalCard
            key={awaitingDecision.toolUseId}
            action={awaitingDecision}
            disabled={busy}
            onDecide={(decision, message) => void submitDecision(decision, message)}
          />
        </View>
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
      <ChatComposer
        value={draft}
        onChangeText={setDraft}
        onSend={send}
        streaming={busy}
        onStop={() => void stop()}
        placeholder={card ? "Message about this card..." : "Message PIN AI..."}
        bottomInset={bottomInset}
      />
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
  assistantRow: { marginVertical: 6, width: "100%" },
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
  timestamp: { marginTop: 3, fontSize: 10, color: "#a1a1aa", textAlign: "right" },
  hitlInlineWrap: { paddingTop: 4 },
  hitlFallbackWrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  hitlCard: {
    borderRadius: 12,
    backgroundColor: "rgba(255,251,235,0.4)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.3)",
    overflow: "hidden",
  },
  hitlHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  hitlIconBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "rgba(252,211,77,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  hitlIcon: { fontSize: 13 },
  hitlHeaderCopy: { flex: 1, minWidth: 0 },
  hitlKicker: {
    marginBottom: 4,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0.8,
    color: "rgba(180,83,9,0.7)",
    fontFamily: "Inter_600SemiBold",
  },
  hitlTitle: {
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(29,33,48,0.85)",
    fontFamily: "Inter_600SemiBold",
  },
  hitlDetailWrap: { paddingHorizontal: 12, paddingBottom: 8 },
  hitlDetail: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "rgba(29,33,48,0.03)",
    color: "rgba(29,33,48,0.7)",
    fontSize: 13,
    lineHeight: 18,
  },
  hitlRejectPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(29,33,48,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  hitlReasonInputRow: {
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(29,33,48,0.12)",
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.55)",
  },
  hitlReasonInput: {
    flex: 1,
    minHeight: 56,
    paddingHorizontal: 0,
    paddingVertical: 2,
    color: "#1d2130",
    fontSize: 12,
    lineHeight: 16,
    textAlignVertical: "top",
  },
  hitlActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
  },
  hitlActionBar: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(29,33,48,0.08)",
  },
  hitlRejectActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
  },
  hitlButton: {
    minHeight: 32,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  hitlApprove: { backgroundColor: "#1a1a1a" },
  hitlGhostButton: { backgroundColor: "transparent" },
  hitlDangerButton: { backgroundColor: "#ef4444" },
  hitlApproveText: { color: "#fff", fontSize: 13, lineHeight: 18, fontFamily: "Inter_600SemiBold" },
  hitlRejectText: { color: "#1d2130", fontSize: 13, lineHeight: 18, fontFamily: "Inter_600SemiBold" },
  hitlDisabled: { opacity: 0.5 },
});
