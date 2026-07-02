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
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeInDown } from "react-native-reanimated";
import {
  cardActionFeedbackBody,
  conversationInit,
  deriveCardResultMessageId,
  describeApproval,
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
import MainChatLanding from "../components/chat/MainChatLanding";
import JumpToLatest from "../components/chat/JumpToLatest";
import { VoiceButton } from "../voice";

import { notifyThreadActivity, readLocalHistory } from "../lib/sync/sync-bootstrap";
import { postCardFeedback } from "../hooks/useCardActions";

/** 离底多少 px 内算「贴底」（跟随态）。略松，掩盖流式贴底动画的中间帧抖动。 */
const AT_BOTTOM_THRESHOLD = 80;

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
  const { t } = useTranslation("common");
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
            <ShimmerText text={t("status.thinking")} style={styles.thinkingText} />
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
  /** 面板「打开」信号：false→true 时强制回到底部（面板常 mount 保流、不 remount，
   *  故靠此显式落底，让每次进来都停在最新一条）。 */
  open?: boolean;
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
  const { t } = useTranslation("chat");
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
          <Text style={styles.hitlKicker}>{t("hitl.needsApproval").toUpperCase()}</Text>
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
              placeholder={t("hitl.rejectReasonPlaceholder")}
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
              <Text style={styles.hitlRejectText}>{t("hitl.back")}</Text>
            </Pressable>
            <Pressable
              style={[styles.hitlButton, styles.hitlDangerButton, (disabled || submitting) && styles.hitlDisabled]}
              disabled={disabled || submitting}
              onPress={() => decide("reject", reason.trim() || undefined)}
            >
              <Text style={styles.hitlApproveText}>{t("hitl.reject")}</Text>
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
              <Text style={styles.hitlRejectText}>{t("hitl.reject")}</Text>
            </Pressable>
          ) : null}
          {canApprove ? (
            <Pressable
              style={[styles.hitlButton, styles.hitlApprove, (disabled || submitting) && styles.hitlDisabled]}
              disabled={disabled || submitting}
              onPress={() => decide("approve")}
            >
              <Check size={14} color="#fff" strokeWidth={2} />
              <Text style={styles.hitlApproveText}>{t("hitl.approve")}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

export default function ChatScreen({ kind, cardId, bootstrap, card, onCardClose, bottomInset, open }: ChatScreenProps) {
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
      open={open}
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
  open,
}: {
  sessionKey: string;
  bootstrap?: string;
  draft: string;
  setDraft: (s: string) => void;
  listRef: React.RefObject<FlatList<ConversationEntry> | null>;
  card?: IntentCard;
  onCardClose?: () => void;
  bottomInset?: number;
  open?: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
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

  // 倒置列表（业界标准聊天做法：RN 官方文档 + react-native-gifted-chat 同款）：
  // data 反转，最新一条 = index 0 = 视觉底部，FlatList `inverted` 让其**天生停在
  // 底部**——首屏 / 重开都无需 scrollToEnd、无需补帧；流式新内容长在底部、自动留
  // 底，历史往上加载时底部纹丝不动。整套「跟随状态机」由此消失。
  const data = useMemo(() => visible.slice().reverse(), [visible]);
  const isEmpty = data.length === 0;

  // JumpToLatest：倒置下 offset.y≈0 即贴最新（视觉底部）；离底则显示按钮。
  const [showJump, setShowJump] = useState(false);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const showJumpRef = useRef(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const atBottom = e.nativeEvent.contentOffset.y <= AT_BOTTOM_THRESHOLD;
    showJumpRef.current = !atBottom;
    setShowJump(!atBottom);
    if (atBottom) setHasNewBelow(false);
  }, []);
  const jumpToLatest = useCallback(() => {
    setHasNewBelow(false);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [listRef]);

  // 离底时来了新一条 → 点亮 attention 红点（对齐 web hasNewBelow：下方有新内容）。
  const prevLenRef = useRef(visible.length);
  useEffect(() => {
    if (visible.length > prevLenRef.current && showJumpRef.current) setHasNewBelow(true);
    prevLenRef.current = visible.length;
  }, [visible.length]);

  // 每次「打开」面板回到底部（用户预期：进来永远停在最新一条）。面板常 mount 保流、
  // open false→true 不 remount，故显式落底。倒置列表 offset 0 永远精确 = 最新一条，
  // **单次** scrollToOffset 即可，无需 scrollToEnd 的多帧补位。
  useEffect(() => {
    if (open) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [open, listRef]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {connection === "reconnecting" ? (
        <Text style={styles.connection}>reconnecting…</Text>
      ) : null}
      <View style={styles.listWrap}>
        {isEmpty ? (
          !ready ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator color="#71717a" />
            </View>
          ) : card ? (
            // card chat 空状态短暂可见（永远 bootstrap）：仅留水晶球。
            // active={open}：card chat 关闭(常驻挂载、滑出屏外)时暂停视频解码省电。
            <View style={styles.emptyWrap}>
              <AiSphere size={200} mode="idle" active={open} />
            </View>
          ) : (
            // main chat landing：web MinimalistLanding 同构（球 + 问候 + 建议 chip）。
            // 倒置 FlatList 的 ListEmptyComponent 会被 scaleY(-1) 翻转，故 landing 不进
            // 列表，单独用 ScrollView 渲染（内容超屏可滚、键盘弹起不挤）。
            <ScrollView
              contentContainerStyle={styles.landingScroll}
              keyboardShouldPersistTaps="handled"
            >
              <MainChatLanding onSubmit={send} active={open} />
            </ScrollView>
          )
        ) : (
          <FlatList
            ref={listRef}
            inverted
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={data}
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
            onScroll={onScroll}
            scrollEventThrottle={16}
          />
        )}
        {/* 回到最新：视口离开底部时悬浮（对齐 web JumpToLatest）。 */}
        {!isEmpty && showJump ? (
          <JumpToLatest attention={hasNewBelow || !!awaitingDecision} onPress={jumpToLatest} />
        ) : null}
      </View>
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
        placeholder={card ? t("cardContext.messagePlaceholder") : t("composer.placeholder")}
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
  // FlatList + 悬浮 JumpToLatest 的相对定位容器（按钮 absolute 贴此容器底部）。
  listWrap: { flex: 1 },
  list: { flex: 1 },
  listContent: { padding: 16 },
  // main chat 空 landing 的滚动容器（倒置列表外，单独渲染）。paddingHorizontal 16
  // 对齐聊天内容左右边距，保证 landing 的建议 chip 宽度与会话态一致。
  landingScroll: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 8 },
  emptyWrap: { alignItems: "center", marginTop: 48 },
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
  thinkingText: { fontSize: 15, fontFamily: "Geist_500Medium", color: "rgba(29,33,48,0.65)" },
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
    fontFamily: "Geist_600SemiBold",
  },
  hitlTitle: {
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(29,33,48,0.85)",
    fontFamily: "Geist_600SemiBold",
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
  hitlApproveText: { color: "#fff", fontSize: 13, lineHeight: 18, fontFamily: "Geist_600SemiBold" },
  hitlRejectText: { color: "#1d2130", fontSize: 13, lineHeight: 18, fontFamily: "Geist_600SemiBold" },
  hitlDisabled: { opacity: 0.5 },
});
