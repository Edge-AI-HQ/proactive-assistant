import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Mic, Send, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useVoiceInput, Waveform, appendVoiceTranscript } from "../../voice";
import { Text } from "../../primitives/Text";
import { PermissionModeMenu } from "./PermissionModeMenu";

function formatRecordDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Composer({
  onSend,
  onFocusChange,
  placeholder,
  streaming = false,
  onStop,
}: {
  onSend: (text: string) => Promise<void>;
  onFocusChange?: (focused: boolean) => void;
  placeholder?: string;
  /** A turn is streaming on this thread → the send button becomes a Stop
   *  button and sending is gated (Claude/ChatGPT model: stop first, then send). */
  streaming?: boolean;
  onStop?: () => void | Promise<void>;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Track keyboard visibility (events dispatched from main.tsx on Capacitor
  // Keyboard willShow/willHide) so we can offer a dismiss-keyboard button on
  // mobile — same affordance the old ConversationView composer had.
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const show = () => setKbVisible(true);
    const hide = () => setKbVisible(false);
    window.addEventListener("pinai:kbShow", show);
    window.addEventListener("pinai:kbHide", hide);
    return () => {
      window.removeEventListener("pinai:kbShow", show);
      window.removeEventListener("pinai:kbHide", hide);
    };
  }, []);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setText("");
    setSending(true);
    try {
      await onSend(trimmed);
    } catch (err) {
      console.warn("[proactive] send failed:", err);
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  // ── Inline voice recording (reference Conversation.tsx UI on our real
  //    engine). The input bar morphs into a recording bar: live transcript +
  //    duration + waveform + Cancel/Confirm. Confirm fills the input (appends
  //    to any draft) so the user can review and send. ──
  const { startCapture, stopCapture, captureStatus } = useVoiceInput();
  const [recording, setRecording] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceFinalizing, setVoiceFinalizing] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const recordingRef = useRef(false);

  const startRecording = useCallback(() => {
    setVoiceTranscript("");
    setVoiceFinalizing(false);
    setRecordSec(0);
    setRecording(true);
    startCapture({
      inline: true,
      onUpdate: setVoiceTranscript,
      onError: setVoiceTranscript,
      onResult: (final) => {
        // Append the transcript to the existing draft, then leave it in the
        // input for the user to review / edit / send (not auto-sent).
        setText((prev) => appendVoiceTranscript(prev, final));
        setRecording(false);
        setVoiceFinalizing(false);
        setVoiceTranscript("");
        // Refocus so the keyboard returns and the user can keep editing.
        window.setTimeout(() => taRef.current?.focus(), 0);
      },
    });
  }, [startCapture]);

  const cancelRecording = useCallback(() => {
    void stopCapture(false);
    setRecording(false);
    setVoiceFinalizing(false);
    setVoiceTranscript("");
  }, [stopCapture]);

  const confirmRecording = useCallback(() => {
    setVoiceFinalizing(true); // onResult clears it + exits recording
    void stopCapture(true);
  }, [stopCapture]);

  // Recording duration ticker.
  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    const t = window.setInterval(
      () => setRecordSec(Math.floor((Date.now() - startedAt) / 1000)),
      250,
    );
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // Cancel an in-flight capture if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recordingRef.current) void stopCapture(false);
    };
  }, [stopCapture]);

  const canSend = !!text.trim() && !sending;
  const voiceConnecting = recording && captureStatus === "connecting";
  return (
    <div
      className="shrink-0 px-3 pt-2"
      // Lift the composer off the bottom edge. Keyboard up → float above it
      // (--kb-height, set by main.tsx); keyboard down → a base gap (≈ pb-6)
      // that also clears the home indicator (safe-area). Inline `paddingBottom`
      // would otherwise override any `pb-*` class, which is why it was hugging
      // the bottom when --kb-height resolved to 0.
      style={{
        paddingBottom:
          "max(var(--kb-height, 0px), env(safe-area-inset-bottom, 0px), 1.5rem)",
      }}
    >
      {recording ? (
        <div
          className="flex flex-col gap-2 rounded-3xl border border-foreground/[0.08] px-4 py-3"
          style={{
            background: "linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.25) 100%)",
            backdropFilter: "blur(24px) saturate(1.8)",
            WebkitBackdropFilter: "blur(24px) saturate(1.8)",
            boxShadow:
              "inset 0 1px 1px rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.02)",
          }}
        >
          <p className="flex min-h-[20px] items-center gap-1.5 text-body italic leading-snug text-foreground/55">
            {voiceConnecting && !voiceFinalizing && !voiceTranscript && (
              <Loader2 size={14} strokeWidth={2} className="shrink-0 animate-spin" />
            )}
            <span className="min-w-0 truncate">
              {voiceFinalizing
                ? t("common:status.polishing")
                : voiceTranscript ||
                  (voiceConnecting
                    ? t("common:status.connecting")
                    : t("common:status.listening"))}
            </span>
          </p>
          <div className="flex items-center gap-2.5">
            <Text variant="label" weight="medium" className="w-[40px] shrink-0 tabular-nums text-foreground/55">
              {formatRecordDuration(recordSec)}
            </Text>
            {voiceConnecting ? (
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <Loader2 size={19} strokeWidth={2} className="animate-spin text-foreground/50" />
              </div>
            ) : (
              <Waveform className="flex-1" />
            )}
            <button
              type="button"
              onClick={cancelRecording}
              disabled={voiceFinalizing}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/55 transition-colors hover:bg-foreground/10 disabled:opacity-40"
              aria-label={t("composer.cancelRecording")}
            >
              <X size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => void confirmRecording()}
              disabled={voiceFinalizing || voiceConnecting}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-background transition-transform active:scale-95 disabled:opacity-60"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)",
                boxShadow: "0 4px 12px hsl(var(--primary) / 0.35)",
              }}
              aria-label={t("composer.useTranscript")}
            >
              <Check size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      ) : (
      <div
        className="flex items-end gap-2 rounded-3xl border border-foreground/[0.08] py-2 pl-4 pr-2 transition-colors focus-within:border-foreground/[0.18]"
        style={{
          background: "linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.25) 100%)",
          backdropFilter: "blur(24px) saturate(1.8)",
          WebkitBackdropFilter: "blur(24px) saturate(1.8)",
          boxShadow:
            "inset 0 1px 1px rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.02)",
        }}
        onFocusCapture={() => onFocusChange?.(true)}
        onBlurCapture={() => onFocusChange?.(false)}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t("composer.placeholder")}
          rows={1}
          className="min-h-9 max-h-[120px] flex-1 resize-none bg-transparent py-2 text-body leading-[20px] text-foreground outline-none placeholder:text-foreground/35"
        />
        {kbVisible && (
          <button
            type="button"
            // preventDefault so the click doesn't blur the textarea first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (document.activeElement as HTMLElement | null)?.blur?.()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80"
            title={t("composer.dismissKeyboard")}
          >
            <ChevronDown size={18} strokeWidth={1.6} />
          </button>
        )}
        <button
          type="button"
          onClick={startRecording}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80"
          aria-label={t("composer.voiceInput")}
        >
          <Mic size={18} strokeWidth={1.6} />
        </button>
        {streaming ? (
          <button
            type="button"
            onClick={() => void onStop?.()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/90 text-background transition-all active:scale-95 hover:bg-foreground"
            aria-label={t("composer.stop")}
            title={t("composer.stop")}
          >
            <Square size={12} strokeWidth={2} fill="currentColor" />
          </button>
        ) : null}
        {streaming && !canSend ? null : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-95"
            style={
              canSend
                ? {
                    background:
                      "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)",
                    boxShadow: "0 4px 12px hsl(var(--primary) / 0.35)",
                    color: "hsl(var(--background))",
                  }
                : {
                    background: "hsl(var(--foreground) / 0.08)",
                    color: "hsl(var(--foreground) / 0.35)",
                  }
            }
            aria-label={streaming ? t("queued.queueMessage") : t("composer.send")}
            title={streaming ? t("queued.queueMessage") : t("composer.send")}
          >
            <Send size={15} strokeWidth={2} />
          </button>
        )}
      </div>
      )}
      {!recording && <PermissionModeMenu />}
    </div>
  );
}
