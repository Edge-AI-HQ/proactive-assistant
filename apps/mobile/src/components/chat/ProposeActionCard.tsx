/**
 * ProposeActionCard——web ui-web/chat/conversation/ProposeActionCard 的 RN 介质版。
 * card-execution agent 调 propose_action 工具暂停征询时，在会话里渲染：可选 drafts
 * 折叠卡 + 粉色「NEEDS YOUR INPUT」面板（脉冲点 + 标题 + agent 消息 + 选项单选
 * chips + 自由文本输入 + Continue）。点 chip 或输入 + Continue → onReply（= runtime
 * sendMessage），agent 下一轮作为 HumanMessage 收到。解析（args.input.{message,
 * drafts,options}）照搬 web parseArgs（纯函数）。
 *
 * 与 web 的差异（标注）：plan / dangerous_actions / risks 不在会话卡渲染
 * （审计字段，归卡片详情，与 web 一致）。
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, LayoutAnimation, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowRight, Check, ChevronUp, FileText, Mail, MessageSquare } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";

import { usePageActive } from "../app/KeepAlivePage";

import { VoiceButton } from "../../voice";

const FG = "29,33,48";
/** --primary hsl(292 78% 63%) ≈ rgb(215,87,234)。 */
const PRIMARY = "215,87,234";

interface Artifact {
  kind: "email_draft" | "message" | "doc" | "other";
  title: string;
  body: string;
}
interface Parsed {
  message: string;
  drafts: Artifact[];
  options: string[];
}

/** 照搬 web parseArgs：优先 args.input 的结构化负载，缺失则回落顶层键。 */
function parseArgs(raw: unknown): Parsed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const inner = r.input && typeof r.input === "object" ? (r.input as Record<string, unknown>) : r;
  const message = typeof inner.message === "string" ? inner.message : "";
  if (!message) return null;
  const drafts = Array.isArray(inner.drafts)
    ? (inner.drafts.filter((d) => d && typeof d === "object") as Artifact[])
    : [];
  const options = Array.isArray(inner.options)
    ? (inner.options.filter((o) => typeof o === "string") as string[])
    : [];
  return { message, drafts, options };
}

const ARTIFACT_ICON = { email_draft: Mail, message: MessageSquare, doc: FileText, other: FileText } as const;
const ARTIFACT_LABEL_KEY = { email_draft: "emailDraft", message: "messageDraft", doc: "document", other: "draft" } as const;

function DraftItem({ artifact, index }: { artifact: Artifact; index: number }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(index === 0);
  const Icon = ARTIFACT_ICON[artifact.kind] ?? FileText;
  return (
    <View style={styles.draft}>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.create(260, "easeInEaseOut", "opacity"));
          setExpanded((v) => !v);
        }}
        style={styles.draftHeader}
        accessibilityRole="button"
      >
        <View style={styles.draftIcon}>
          <Icon size={14} color={`rgba(${FG},0.65)`} strokeWidth={1.8} />
        </View>
        <View style={styles.flex1}>
          <Text style={styles.draftLabel}>{t(`artifact.${ARTIFACT_LABEL_KEY[artifact.kind] ?? "draft"}`).toUpperCase()}</Text>
          <Text style={styles.draftTitle} numberOfLines={1}>
            {artifact.title}
          </Text>
        </View>
        <ChevronUp size={14} color={`rgba(${FG},0.35)`} style={expanded ? undefined : styles.flip} />
      </Pressable>
      {expanded ? (
        <View style={styles.draftBody}>
          <Text style={styles.draftText}>{artifact.body}</Text>
        </View>
      ) : null}
    </View>
  );
}

function PulseDot() {
  const v = useSharedValue(0);
  const active = usePageActive();
  useEffect(() => {
    if (!active) {
      cancelAnimation(v);
      return;
    }
    v.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => cancelAnimation(v);
  }, [v, active]);
  const st = useAnimatedStyle(() => ({ opacity: 0.55 + v.value * 0.45, transform: [{ scale: 1 + v.value * 0.15 }] }));
  return <Animated.View style={[styles.pulseDot, st]} />;
}

export default function ProposeActionCard({
  args,
  onReply,
  busy,
}: {
  args: unknown;
  onReply: (text: string) => void | Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation("chat");
  const parsed = parseArgs(args);
  const [inputValue, setInputValue] = useState("");
  const [selectedOption, setSelectedOption] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // agent 换了问题（message 变）→ 重置面板（un-sent 干净默认）。
  useEffect(() => {
    setSelectedOption(0);
    setInputValue("");
    setSent(false);
    setInputFocused(false);
  }, [parsed?.message]);

  if (!parsed) return null;
  const { message, drafts, options } = parsed;
  const isRunning = busy || submitting;
  const locked = isRunning || sent;
  // Focused (or typed-in) input becomes the selected choice → option chips
  // de-highlight. (Web keeps the chip lit until you type; this reads clearer.)
  const inputActive = inputFocused || !!inputValue.trim();

  const submitReply = async () => {
    const typed = inputValue.trim();
    const replyText = typed || options[selectedOption] || "";
    if (!replyText || locked) return;
    setInputValue("");
    setSubmitting(true);
    try {
      await onReply(replyText);
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  const canContinue = !locked && (options.length > 0 || !!inputValue.trim());

  return (
    <View style={styles.wrap}>
      {drafts.map((d, i) => (
        <DraftItem key={i} artifact={d} index={i} />
      ))}

      <View style={styles.panel}>
        <View style={styles.panelHead}>
          <PulseDot />
          <Text style={styles.needsInput}>{t("proposeAction.needsInput").toUpperCase()}</Text>
        </View>

        <Text style={styles.message}>{message}</Text>

        {options.length > 0 ? (
          <View style={styles.options}>
            {options.map((opt, i) => {
              const isSelected = i === selectedOption && !inputActive;
              return (
                <Pressable
                  key={i}
                  disabled={locked}
                  onPress={() => {
                    inputRef.current?.blur();
                    setInputFocused(false);
                    setSelectedOption(i);
                    if (inputValue) setInputValue("");
                  }}
                  style={[styles.option, isSelected ? styles.optionSelected : styles.optionIdle]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>{opt}</Text>
                  <View style={[styles.radio, isSelected && styles.radioOn]}>
                    {isSelected ? <Check size={10} strokeWidth={3} color="#fff" /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={[styles.inputRow, inputActive && styles.inputRowActive]}>
          <TextInput
            ref={inputRef}
            value={inputValue}
            onChangeText={setInputValue}
            onSubmitEditing={() => void submitReply()}
            editable={!locked}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder={
              sent
                ? t("proposeAction.replySent")
                : options.length > 0
                  ? t("proposeAction.typeOwnReplyPlaceholder")
                  : t("proposeAction.typeReplyPlaceholder")
            }
            placeholderTextColor={`rgba(${FG},0.35)`}
            style={styles.input}
            returnKeyType="send"
          />
          <VoiceButton prefill={inputValue} onUpdate={setInputValue} disabled={locked} />
        </View>

        <Pressable
          onPress={() => void submitReply()}
          disabled={!canContinue}
          style={[styles.continue, !canContinue && styles.dim]}
          accessibilityRole="button"
          accessibilityLabel={t("proposeAction.continue")}
        >
          {sent ? (
            <Check size={13} strokeWidth={2.5} color="#fff" />
          ) : isRunning ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : null}
          <Text style={styles.continueText}>
            {sent ? t("proposeAction.sent") : isRunning ? t("proposeAction.sending") : t("proposeAction.continue")}
          </Text>
          {!sent && !isRunning ? <ArrowRight size={13} strokeWidth={2.5} color="#fff" /> : null}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: 12, gap: 12 },
  draft: { borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: `rgba(${FG},0.08)`, backgroundColor: "rgba(255,255,255,0.65)" },
  draftHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  draftIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: "#fff", borderWidth: 1, borderColor: `rgba(${FG},0.1)`, alignItems: "center", justifyContent: "center" },
  draftLabel: { fontSize: 10, fontFamily: "Geist_600SemiBold", letterSpacing: 0.5, color: `rgba(${FG},0.4)`, marginBottom: 2 },
  draftTitle: { fontSize: 13, fontFamily: "Geist_600SemiBold", color: `rgba(${FG},0.85)` },
  draftBody: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12, borderTopWidth: 1, borderTopColor: `rgba(${FG},0.06)` },
  draftText: { fontSize: 13, color: `rgba(${FG},0.75)`, lineHeight: 19, fontFamily: "Geist_400Regular" },
  flex1: { flex: 1, minWidth: 0 },
  flip: { transform: [{ rotate: "180deg" }] },

  panel: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1, borderColor: `rgba(${PRIMARY},0.35)`, backgroundColor: "rgba(255,255,255,0.6)" },
  panelHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 },
  pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: `rgb(${PRIMARY})` },
  needsInput: { fontSize: 11, fontFamily: "Geist_700Bold", letterSpacing: 0.6, color: `rgb(${PRIMARY})` },
  message: { fontSize: 13, fontFamily: "Geist_500Medium", color: `rgba(${FG},0.85)`, lineHeight: 19, marginBottom: 10 },

  options: { gap: 12 },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1 },
  optionIdle: { backgroundColor: "rgba(255,255,255,0.5)", borderColor: `rgba(${FG},0.08)` },
  optionSelected: { backgroundColor: `rgba(${FG},0.04)`, borderColor: `rgba(${FG},0.55)` },
  optionText: { flex: 1, fontSize: 13, color: `rgba(${FG},0.7)`, fontFamily: "Geist_400Regular" },
  optionTextSelected: { color: `rgb(${FG})`, fontFamily: "Geist_500Medium" },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: `rgba(${FG},0.18)`, alignItems: "center", justifyContent: "center" },
  radioOn: { backgroundColor: `rgb(${FG})`, borderColor: `rgb(${FG})` },

  inputRow: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.1)`,
    backgroundColor: "rgba(255,255,255,0.55)",
    paddingLeft: 12,
    paddingRight: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  inputRowActive: { borderColor: `rgba(${FG},0.55)`, backgroundColor: `rgba(${FG},0.04)` },
  input: { flex: 1, minHeight: 40, fontSize: 13, color: `rgb(${FG})`, fontFamily: "Geist_400Regular" },

  continue: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 12, height: 44, borderRadius: 12, backgroundColor: "#1d2130" },
  continueText: { fontSize: 14, fontFamily: "Geist_600SemiBold", color: "#fff" },
  dim: { opacity: 0.4 },
});
