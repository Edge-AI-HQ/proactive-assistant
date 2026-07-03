import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Check, ChevronDown, Mic, Send, Square, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";

import PermissionModeMenu from "./PermissionModeMenu";
import { Waveform } from "../../voice/Waveform";
import { formatDuration } from "../../voice/VoiceButton";
import { useVoiceInput } from "../../voice/VoiceProvider";

const FG = "29,33,48";
const PRIMARY = "hsl(292, 78%, 63%)";
const PINK = "hsl(330, 80%, 65%)";

export default function ChatComposer({
  value,
  onChangeText,
  onSend,
  streaming,
  onStop,
  placeholder,
  bottomInset = 0,
  disabled,
}: {
  value: string;
  onChangeText: (next: string) => void;
  onSend: (text: string) => void | Promise<void>;
  streaming: boolean;
  onStop: () => void | Promise<void>;
  placeholder?: string;
  bottomInset?: number;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { startCapture, stopCapture, isCapturing, captureStatus } = useVoiceInput();
  const [sending, setSending] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordStartedAtRef = useRef(0);
  const draftBeforeRecordRef = useRef("");

  useEffect(() => {
    const showName = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideName = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showName, () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(hideName, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - recordStartedAtRef.current), 250);
    return () => clearInterval(timer);
  }, [recording]);

  const submit = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled || sending) return;
    onChangeText("");
    setSending(true);
    try {
      await onSend(text);
    } finally {
      setSending(false);
    }
  }, [disabled, onChangeText, onSend, sending, value]);

  const startRecording = useCallback(() => {
    if (disabled || (isCapturing && !recording)) return;
    draftBeforeRecordRef.current = value;
    recordStartedAtRef.current = Date.now();
    setElapsedMs(0);
    setVoiceError(null);
    setRecording(true);
    startCapture({
      prefill: value,
      onUpdate: onChangeText,
      onError: (message) => {
        // dev 语义(ui-web VoiceButton onError):错误显示在录音条内、条不退、
        // 可 Cancel。同时必须停掉采集——否则 mic 悬空 + isCapturing 守卫锁死重开。
        setVoiceError(message);
        void stopCapture(false);
      },
      onResult: (text) => {
        onChangeText(text);
        setRecording(false);
      },
    });
  }, [disabled, isCapturing, onChangeText, recording, startCapture, stopCapture, value]);

  const finishRecording = useCallback(
    async (commit: boolean) => {
      if (!recording) return;
      if (!commit) onChangeText(draftBeforeRecordRef.current);
      await stopCapture(commit);
      setRecording(false);
    },
    [onChangeText, recording, stopCapture],
  );

  const hasText = value.trim().length > 0;
  const canSend = hasText && !disabled && !sending;
  const bottomPadding = Math.max(bottomInset, 24);

  if (recording) {
    return (
      <View style={[styles.root, { paddingBottom: bottomPadding }]}>
        <View style={styles.recordingBar}>
          <BlurView intensity={30} tint="light" style={[StyleSheet.absoluteFill, styles.rounded]} />
          <View style={[StyleSheet.absoluteFill, styles.glassTint, styles.rounded]} />
          <Pressable
            onPress={() => void finishRecording(false)}
            accessibilityRole="button"
            accessibilityLabel={t("composer.cancelRecording")}
            style={styles.recordIconButton}
          >
            <X size={18} color={`rgba(${FG},0.58)`} strokeWidth={2.1} />
          </Pressable>
          <View style={styles.recordCopy}>
            <Text style={styles.recordStatus}>
              {voiceError ?? (captureStatus === "connecting" ? t("common:status.connecting") : t("common:status.listening"))}
            </Text>
            <Text style={styles.recordTranscript} numberOfLines={1}>
              {value.trim() || "Speak now"}
            </Text>
          </View>
          <Text style={styles.recordTimer}>{formatDuration(elapsedMs)}</Text>
          <Waveform active={captureStatus === "listening"} style={styles.recordWave} />
          <Pressable
            onPress={() => void finishRecording(true)}
            accessibilityRole="button"
            accessibilityLabel={t("composer.useTranscript")}
            style={[styles.recordIconButton, styles.recordConfirm]}
          >
            <Check size={18} color="#fff" strokeWidth={2.3} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingBottom: bottomPadding }]}>
      <View style={styles.inputBar}>
        <BlurView intensity={34} tint="light" style={[StyleSheet.absoluteFill, styles.rounded]} />
        <View style={[StyleSheet.absoluteFill, styles.glassTint, styles.rounded]} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder ?? t("composer.placeholder")}
          placeholderTextColor={`rgba(${FG},0.35)`}
          editable={!disabled}
          multiline
          returnKeyType="send"
          style={styles.input}
        />
        {keyboardVisible ? (
          <Pressable
            onPress={() => Keyboard.dismiss()}
            accessibilityRole="button"
            accessibilityLabel={t("composer.dismissKeyboard")}
          >
            <View style={styles.iconButton}>
              <ChevronDown size={20} color={`rgba(${FG},0.5)`} strokeWidth={2} />
            </View>
          </Pressable>
        ) : null}
        <Pressable
          onPress={startRecording}
          disabled={disabled || isCapturing}
          accessibilityRole="button"
          accessibilityLabel={t("composer.voiceInput")}
        >
          <View style={[styles.iconButton, (disabled || isCapturing) && styles.dim]}>
            <Mic size={18} color={`rgba(${FG},0.55)`} strokeWidth={1.6} />
          </View>
        </Pressable>
        {/* 与 web Composer 同构:streaming 时 Stop 常驻;有草稿时 Send 并列在旁
            (= 排队下一条,Claude/ChatGPT 模型:先停或排队)。 */}
        {streaming ? (
          <Pressable
            onPress={() => void onStop()}
            accessibilityRole="button"
            accessibilityLabel={t("composer.stop")}
          >
            <View style={[styles.sendButton, styles.stopButton]}>
              <Square size={12} color="#fff" fill="#fff" strokeWidth={2} />
            </View>
          </Pressable>
        ) : null}
        {streaming && !canSend ? null : (
          <Pressable
            onPress={() => void submit()}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={streaming ? t("queued.queueMessage") : t("composer.send")}
          >
            <View style={[styles.sendButton, !canSend && styles.sendDisabled]}>
              {canSend ? (
                <LinearGradient
                  colors={[PRIMARY, PINK]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
              ) : null}
              {sending ? (
                <ActivityIndicator size="small" color={canSend ? "#fff" : `rgba(${FG},0.35)`} />
              ) : (
                // lucide-react-native ignores `transform` in its own style (same
                // gotcha as chevron rotate) → wrap in a View to optically center
                // the paper-plane (its visual mass sits up-right of the glyph's
                // geometric center; web's flex-center has no nudge but RN reads
                // it as off-center). Nudge left+down.
                <View style={styles.sendIcon}>
                  <Send size={15} color={canSend ? "#fff" : `rgba(${FG},0.35)`} strokeWidth={2} />
                </View>
              )}
            </View>
          </Pressable>
        )}
      </View>
      <PermissionModeMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  inputBar: {
    minHeight: 52,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  rounded: { borderRadius: 24 },
  glassTint: { backgroundColor: "rgba(255,255,255,0.46)" },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 0,
    fontSize: 15,
    lineHeight: 20,
    color: `rgba(${FG},0.9)`,
    fontFamily: "Geist_400Regular",
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  iconPressed: { backgroundColor: `rgba(${FG},0.06)` },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  sendDisabled: { backgroundColor: `rgba(${FG},0.12)` },
  // optical-center nudge for the lucide paper-plane (left 1 / down 1).
  sendIcon: { transform: [{ translateX: -1 }, { translateY: 1 }] },
  stopButton: { backgroundColor: `rgba(${FG},0.92)` },
  pressed: { opacity: 0.75 },
  dim: { opacity: 0.4 },
  recordingBar: {
    minHeight: 58,
    borderRadius: 29,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  recordIconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `rgba(${FG},0.06)`,
  },
  recordConfirm: { backgroundColor: "#1d2130" },
  recordCopy: { flex: 1, minWidth: 0 },
  recordStatus: {
    fontSize: 11,
    lineHeight: 14,
    color: `rgba(${FG},0.45)`,
    fontFamily: "Geist_600SemiBold",
    textTransform: "uppercase",
  },
  recordTranscript: {
    marginTop: 3,
    fontSize: 16,
    lineHeight: 21,
    color: `rgba(${FG},0.78)`,
    fontFamily: "Geist_500Medium",
  },
  recordTimer: {
    width: 38,
    textAlign: "center",
    fontSize: 12,
    color: `rgba(${FG},0.55)`,
    fontFamily: "Geist_600SemiBold",
  },
  recordWave: { width: 72 },
});
