import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, X } from "lucide-react";

import { cn } from "../lib/utils";

import { useVoiceInput } from "./VoiceProvider";
import Waveform from "./Waveform";
import type { StartCaptureOptions } from "./types";

export interface VoiceButtonProps extends StartCaptureOptions {
  className?: string;
  size?: number;
  "aria-label"?: string;
}

// Small mic-icon button that turns into the realtime inline voice capture bar.
// Drop in next to any text input:
//   <VoiceButton prefill={inputValue} onUpdate={setInputValue} />
// For a "voice-only" entry (no text input mirroring), pass onResult instead.
export function VoiceButton({
  className,
  size = 17,
  prefill,
  onUpdate,
  onError,
  onResult,
  "aria-label": ariaLabel,
}: VoiceButtonProps) {
  const { startCapture, stopCapture, isCapturing, captureStatus } = useVoiceInput();
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const initialTextRef = useRef("");
  const initialText = prefill ?? "";

  const startRecording = () => {
    initialTextRef.current = initialText;
    setTranscript("");
    setFinalizing(false);
    setRecording(true);
    startCapture({
      inline: true,
      prefill: initialText,
      onUpdate: (text) => {
        setTranscript(text);
        onUpdate?.(appendVoiceTranscript(initialTextRef.current, text));
      },
      onError: (message) => {
        setTranscript(message);
        onError?.(message);
      },
      onResult: (final) => {
        const next = appendVoiceTranscript(initialTextRef.current, final);
        onUpdate?.(next);
        setRecording(false);
        setFinalizing(false);
        setTranscript("");
        onResult?.(next);
      },
    });
  };

  const cancelRecording = () => {
    void stopCapture(false);
    onUpdate?.(initialTextRef.current);
    setRecording(false);
    setFinalizing(false);
    setTranscript("");
  };

  const confirmRecording = () => {
    setFinalizing(true);
    void stopCapture(true);
  };

  const recordingRef = useRef(recording);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) void stopCapture(false);
    };
  }, [stopCapture]);

  if (recording) {
    const isConnecting = captureStatus === "connecting";
    return (
      <div className="flex min-w-[13rem] flex-1 flex-col gap-2 rounded-2xl border border-foreground/[0.08] px-3 py-2">
        <p className="flex min-h-[18px] items-center gap-1.5 truncate text-[13px] italic leading-snug text-foreground/55">
          {isConnecting && !finalizing && !transcript && (
            <Loader2 size={13} strokeWidth={2} className="shrink-0 animate-spin" />
          )}
          <span className="truncate">
            {finalizing ? "Polishing…" : transcript || (isConnecting ? "Connecting…" : "Listening…")}
          </span>
        </p>
        <div className="flex items-center gap-2.5">
          {isConnecting ? (
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <Loader2 size={18} strokeWidth={2} className="animate-spin text-foreground/50" />
            </div>
          ) : (
            <Waveform className="min-w-0 flex-1" />
          )}
          <button
            type="button"
            onClick={cancelRecording}
            disabled={finalizing}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/55 transition-colors hover:bg-foreground/10 disabled:opacity-40"
            aria-label="Cancel recording"
          >
            <X size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => void confirmRecording()}
            disabled={finalizing || isConnecting}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-background transition-transform active:scale-95 disabled:opacity-60"
            style={{
              background:
                "linear-gradient(135deg, hsl(292 78% 63%) 0%, hsl(330 80% 65%) 100%)",
              boxShadow: "0 4px 12px hsl(292 78% 63% / 0.35)",
            }}
            aria-label="Use transcript"
          >
            <Check size={15} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startRecording}
      disabled={isCapturing}
      className={cn(
        "w-8 h-8 rounded-full bg-foreground/10 flex items-center justify-center text-foreground/60 hover:bg-foreground/15 hover:text-foreground transition-colors disabled:opacity-40",
        className,
      )}
      aria-label={ariaLabel ?? "Voice input"}
    >
      <Mic size={size} strokeWidth={2} />
    </button>
  );
}

export function appendVoiceTranscript(base: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return base;
  if (!base.trim()) return text;
  const needsSpace = !/\s$/.test(base) && !/^[,.;!?，。！？、；：）)\]}]/.test(text);
  return `${base}${needsSpace ? " " : ""}${text}`;
}
