import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Check, Mic, X } from "lucide-react-native";

import { Waveform } from "./Waveform";
import { useVoiceInput } from "./VoiceProvider";

const FG = "29,33,48";

export function VoiceButton({
  prefill = "",
  onUpdate,
  disabled,
  iconColor = `rgba(${FG},0.55)`,
  buttonStyle,
  recordingStyle,
}: {
  prefill?: string;
  onUpdate: (text: string) => void;
  disabled?: boolean;
  iconColor?: string;
  buttonStyle?: StyleProp<ViewStyle>;
  recordingStyle?: StyleProp<ViewStyle>;
}) {
  const { startCapture, stopCapture, isCapturing } = useVoiceInput();
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  const draftBeforeRecordRef = useRef(prefill);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
    return () => clearInterval(timer);
  }, [recording]);

  const start = useCallback(() => {
    if (disabled || (isCapturing && !recording)) return;
    draftBeforeRecordRef.current = prefill;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setError(null);
    setRecording(true);
    startCapture({
      prefill,
      onUpdate,
      onError: (message) => {
        setError(message);
        setRecording(false);
      },
      onResult: (text) => {
        onUpdate(text);
        setRecording(false);
      },
    });
  }, [disabled, isCapturing, onUpdate, prefill, recording, startCapture]);

  const finish = useCallback(
    async (commit: boolean) => {
      if (!recording || stopping) return;
      setStopping(true);
      if (!commit) onUpdate(draftBeforeRecordRef.current);
      await stopCapture(commit);
      setRecording(false);
      setStopping(false);
    },
    [onUpdate, recording, stopCapture, stopping],
  );

  if (recording) {
    return (
      <View style={[styles.recording, recordingStyle]}>
        <Pressable
          onPress={() => void finish(false)}
          disabled={stopping}
          accessibilityRole="button"
          accessibilityLabel="Cancel voice input"
          style={styles.recordingAction}
        >
          <X size={14} color={`rgba(${FG},0.55)`} strokeWidth={2.2} />
        </Pressable>
        <Waveform active={!stopping} style={styles.waveform} />
        <Text style={styles.timer}>{formatDuration(elapsedMs)}</Text>
        <Pressable
          onPress={() => void finish(true)}
          disabled={stopping}
          accessibilityRole="button"
          accessibilityLabel="Use voice input"
          style={[styles.recordingAction, styles.confirm]}
        >
          <Check size={14} color="#fff" strokeWidth={2.3} />
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={start}
      disabled={disabled || isCapturing}
      accessibilityRole="button"
      accessibilityLabel={error ? `Voice input failed: ${error}` : "Voice input"}
      style={({ pressed }) => [
        styles.button,
        buttonStyle,
        (disabled || isCapturing) && styles.dim,
        pressed && !disabled && !isCapturing && styles.pressed,
      ]}
    >
      <Mic size={18} color={iconColor} strokeWidth={1.9} />
    </Pressable>
  );
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: `rgba(${FG},0.06)` },
  dim: { opacity: 0.4 },
  recording: {
    height: 36,
    minWidth: 138,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    backgroundColor: "rgba(255,255,255,0.72)",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 4,
  },
  recordingAction: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  confirm: { backgroundColor: "#1d2130" },
  waveform: { width: 34 },
  timer: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 11,
    color: `rgba(${FG},0.55)`,
    fontFamily: "Inter_500Medium",
  },
});
