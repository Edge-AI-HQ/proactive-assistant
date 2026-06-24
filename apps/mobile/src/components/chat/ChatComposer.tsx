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
import { Check, ChevronDown, Mic, SendHorizontal, Square, X } from "lucide-react-native";

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
  placeholder = "Message PIN AI...",
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
        setVoiceError(message);
        setRecording(false);
      },
      onResult: (text) => {
        onChangeText(text);
        setRecording(false);
      },
    });
  }, [disabled, isCapturing, onChangeText, recording, startCapture, value]);

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
  const showStop = streaming && !canSend;
  const actionDisabled = disabled || sending || (!canSend && !showStop);
  const bottomPadding = bottomInset > 0 ? 16 : 24;

  if (recording) {
    return (
      <View style={[styles.root, { paddingBottom: bottomPadding }]}>
        <View style={styles.recordingBar}>
          <BlurView intensity={30} tint="light" style={[StyleSheet.absoluteFill, styles.rounded]} />
          <View style={[StyleSheet.absoluteFill, styles.glassTint, styles.rounded]} />
          <Pressable
            onPress={() => void finishRecording(false)}
            accessibilityRole="button"
            accessibilityLabel="Cancel voice input"
            style={styles.recordIconButton}
          >
            <X size={18} color={`rgba(${FG},0.58)`} strokeWidth={2.1} />
          </Pressable>
          <View style={styles.recordCopy}>
            <Text style={styles.recordStatus}>
              {voiceError ?? (captureStatus === "connecting" ? "Preparing microphone..." : "Listening...")}
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
            accessibilityLabel="Use voice input"
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
          placeholder={placeholder}
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
            accessibilityLabel="Dismiss keyboard"
            style={styles.iconButton}
          >
            <ChevronDown size={20} color={`rgba(${FG},0.5)`} strokeWidth={2} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={startRecording}
          disabled={disabled || isCapturing}
          accessibilityRole="button"
          accessibilityLabel="Voice input"
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconPressed, (disabled || isCapturing) && styles.dim]}
        >
          <Mic size={18} color={`rgba(${FG},0.55)`} strokeWidth={1.8} />
        </Pressable>
        <Pressable
          onPress={showStop ? () => void onStop() : () => void submit()}
          disabled={actionDisabled}
          accessibilityRole="button"
          accessibilityLabel={showStop ? "Stop" : "Send"}
          style={({ pressed }) => [
            styles.sendButton,
            !canSend && !showStop && styles.sendDisabled,
            showStop && styles.stopButton,
            pressed && !actionDisabled && styles.pressed,
          ]}
        >
          {canSend ? (
            <LinearGradient
              colors={[PRIMARY, PINK]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          {sending ? (
            <ActivityIndicator size="small" color={canSend || showStop ? "#fff" : `rgba(${FG},0.35)`} />
          ) : showStop ? (
            <Square size={12} color="#fff" fill="#fff" strokeWidth={2} />
          ) : (
            <SendHorizontal size={16} color={canSend ? "#fff" : `rgba(${FG},0.35)`} strokeWidth={2} />
          )}
        </Pressable>
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
    borderRadius: 26,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  rounded: { borderRadius: 26 },
  glassTint: { backgroundColor: "rgba(255,255,255,0.46)" },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 0,
    fontSize: 16,
    lineHeight: 20,
    color: `rgba(${FG},0.9)`,
    fontFamily: "Inter_400Regular",
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
  sendDisabled: { backgroundColor: `rgba(${FG},0.1)` },
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
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
  },
  recordTranscript: {
    marginTop: 3,
    fontSize: 16,
    lineHeight: 21,
    color: `rgba(${FG},0.78)`,
    fontFamily: "Inter_500Medium",
  },
  recordTimer: {
    width: 38,
    textAlign: "center",
    fontSize: 12,
    color: `rgba(${FG},0.55)`,
    fontFamily: "Inter_600SemiBold",
  },
  recordWave: { width: 72 },
});
