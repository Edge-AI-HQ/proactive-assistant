import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Mic, X } from "lucide-react";

import { BrowserSpeechEngine } from "./BrowserSpeechEngine";
import { normalizeVoiceLanguage } from "./language";
import type {
  StartCaptureOptions,
  VoiceContextValue,
  VoiceEngine,
  VoiceEngineHandle,
  VoiceProviderProps,
} from "./types";

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoiceInput(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) {
    throw new Error("useVoiceInput must be used inside <VoiceProvider>");
  }
  return ctx;
}

const PULSE_PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ["rgba(225,92,230,0.4)", "rgba(139,92,246,0.35)", "rgba(59,130,246,0.28)"],
  ["rgba(251,146,60,0.4)", "rgba(244,63,94,0.35)", "rgba(168,85,247,0.28)"],
  ["rgba(52,211,153,0.4)", "rgba(59,130,246,0.35)", "rgba(139,92,246,0.28)"],
  ["rgba(244,63,94,0.4)", "rgba(251,146,60,0.35)", "rgba(234,179,8,0.28)"],
  ["rgba(99,102,241,0.4)", "rgba(225,92,230,0.35)", "rgba(244,63,94,0.28)"],
];

export function VoiceProvider({ children, engine, transcriptionLanguage }: VoiceProviderProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [pulseColorIndex, setPulseColorIndex] = useState(0);

  const handleRef = useRef<VoiceEngineHandle | null>(null);
  const optsRef = useRef<StartCaptureOptions | null>(null);
  const transcriptRef = useRef("");
  const transcriptScrollerRef = useRef<HTMLDivElement | null>(null);
  const captureSeqRef = useRef(0);
  const voiceLanguage = useMemo(
    () => normalizeVoiceLanguage(transcriptionLanguage),
    [transcriptionLanguage],
  );
  const activeEngine = useMemo<VoiceEngine>(
    () => engine ?? new BrowserSpeechEngine({ lang: voiceLanguage.browser }),
    [engine, voiceLanguage.browser],
  );

  const finishCapture = useCallback(async (commit: boolean) => {
    const handle = handleRef.current;
    const opts = optsRef.current;
    const seq = captureSeqRef.current;
    if (!commit) captureSeqRef.current += 1;
    handleRef.current = null;
    let completed = true;

    try {
      const stopResult = commit
        ? handle?.stop()
        : handle?.cancel ? handle.cancel() : handle?.stop();
      if (isPromiseLike(stopResult)) {
        setIsFinalizing(true);
        await stopResult;
      }
    } catch {
      completed = false;
      // The engine has already surfaced the error via onError. Close the
      // overlay cleanly so the input is left in its last known state.
    } finally {
      const finalText = transcriptRef.current;
      optsRef.current = null;
      setIsCapturing(false);
      setIsFinalizing(false);
      if (commit && captureSeqRef.current === seq) captureSeqRef.current += 1;
      if (commit && completed && opts?.onResult) opts.onResult(finalText);
    }
  }, []);

  const startCapture = useCallback(
    (opts?: StartCaptureOptions) => {
      // Global singleton — if a previous capture is still alive, drop it silently.
      if (handleRef.current) {
        try {
          if (handleRef.current.cancel) void handleRef.current.cancel();
          else void handleRef.current.stop();
        } catch {
          // ignore
        }
        handleRef.current = null;
      }
      const seq = captureSeqRef.current + 1;
      captureSeqRef.current = seq;
      optsRef.current = opts ?? null;
      transcriptRef.current = "";
      setTranscript("");
      setPulseColorIndex(Math.floor(Math.random() * PULSE_PALETTES.length));
      setIsCapturing(true);
      setIsFinalizing(false);

      const apply = (text: string) => {
        if (captureSeqRef.current !== seq) return;
        transcriptRef.current = text;
        setTranscript(text);
        opts?.onUpdate?.(text);
      };

      const result = activeEngine.start({
        onPartial: apply,
        onFinal: apply,
        onError: () => {
          // Overlay stays open so user can still Cancel / Done; engine itself bailed.
        },
      });
      if (result instanceof Promise) {
        result
          .then((h) => {
            if (captureSeqRef.current !== seq) {
              if (h.cancel) void h.cancel();
              else void h.stop();
              return;
            }
            handleRef.current = h;
          })
          .catch(() => {
            // swallow — onError already fired through callbacks
          });
      } else {
        handleRef.current = result;
      }
    },
    [activeEngine],
  );

  const value = useMemo<VoiceContextValue>(
    () => ({ startCapture, isCapturing }),
    [startCapture, isCapturing],
  );

  const palette = PULSE_PALETTES[pulseColorIndex % PULSE_PALETTES.length];

  useEffect(() => {
    const node = transcriptScrollerRef.current;
    if (!node) return;
    node.scrollLeft = node.scrollWidth;
  }, [transcript, isFinalizing]);

  return (
    <VoiceContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {isCapturing && (
          <>
            <motion.div
              key="voice-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              onClick={() => void finishCapture(false)}
              className="fixed inset-0 z-[9998]"
              style={{
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                background: "rgba(0,0,0,0.05)",
              }}
            />
            <motion.div
              key="voice-panel"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
              className="fixed bottom-0 left-0 right-0 z-[9999] flex flex-col items-center justify-center"
              style={{
                height: "33vh",
                background: "rgba(255,255,255,0.7)",
                backdropFilter: "blur(32px) saturate(1.4)",
                WebkitBackdropFilter: "blur(32px) saturate(1.4)",
                borderRadius: "2rem 2rem 0 0",
                borderTop: "1px solid rgba(255,255,255,0.4)",
                borderLeft: "1px solid rgba(255,255,255,0.3)",
                borderRight: "1px solid rgba(255,255,255,0.3)",
              }}
            >
              <div className="relative flex items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
                <motion.div
                  className="absolute rounded-full"
                  style={{ width: 80, height: 80, background: palette[0] }}
                  animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
                <motion.div
                  className="absolute rounded-full"
                  style={{ width: 80, height: 80, background: palette[1] }}
                  animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.35 }}
                />
                <motion.div
                  className="absolute rounded-full"
                  style={{ width: 80, height: 80, background: palette[2] }}
                  animate={{ scale: [1, 1.25, 1], opacity: [0.4, 0, 0.4] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.7 }}
                />
                <button
                  onClick={() => void finishCapture(false)}
                  className="relative rounded-full bg-foreground flex items-center justify-center text-background shadow-xl"
                  style={{ width: 60, height: 60 }}
                  aria-label="Stop listening"
                >
                  <Mic size={22} strokeWidth={1.8} />
                </button>
              </div>
              <div
                ref={transcriptScrollerRef}
                className="w-full max-w-[min(34rem,calc(100vw-3rem))] overflow-x-auto px-8 mb-5 text-center [&::-webkit-scrollbar]:hidden"
                style={{ scrollbarWidth: "none" }}
                aria-live="polite"
              >
                <p className="inline-block min-w-full whitespace-nowrap text-[14px] text-foreground/60 min-h-[22px] font-medium">
                  {isFinalizing ? "Transcribing..." : transcript || "Listening..."}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => void finishCapture(false)}
                  disabled={isFinalizing}
                  className="text-[13px] text-foreground/60 hover:text-foreground/80 transition-colors flex items-center gap-1.5 px-5 py-1.5 rounded-full border border-foreground/12 bg-foreground/5"
                >
                  <X size={13} strokeWidth={2} /> Cancel
                </button>
                <button
                  onClick={() => void finishCapture(true)}
                  disabled={isFinalizing}
                  className="flex items-center gap-1.5 px-5 py-1.5 rounded-full bg-foreground text-background text-[13px] font-medium hover:bg-foreground/80 transition-colors"
                >
                  <Check size={13} strokeWidth={2.5} /> Done
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </VoiceContext.Provider>
  );
}

function isPromiseLike(value: void | Promise<void> | undefined): value is Promise<void> {
  return Boolean(value && typeof value.then === "function");
}
