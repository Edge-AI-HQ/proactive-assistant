import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Mic, X } from "lucide-react";

import { BrowserSpeechEngine } from "./BrowserSpeechEngine";
import type {
  StartCaptureOptions,
  VoiceContextValue,
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

const defaultEngine = new BrowserSpeechEngine();

export function VoiceProvider({ children, engine = defaultEngine }: VoiceProviderProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [pulseColorIndex, setPulseColorIndex] = useState(0);

  const handleRef = useRef<VoiceEngineHandle | null>(null);
  const optsRef = useRef<StartCaptureOptions | null>(null);
  const transcriptRef = useRef("");

  const finishCapture = useCallback((commit: boolean) => {
    try {
      handleRef.current?.stop();
    } finally {
      handleRef.current = null;
    }
    const opts = optsRef.current;
    const finalText = transcriptRef.current;
    optsRef.current = null;
    setIsCapturing(false);
    if (commit && opts?.onResult) opts.onResult(finalText);
  }, []);

  const startCapture = useCallback(
    (opts?: StartCaptureOptions) => {
      // Global singleton — if a previous capture is still alive, drop it silently.
      if (handleRef.current) {
        try {
          handleRef.current.stop();
        } catch {
          // ignore
        }
        handleRef.current = null;
      }
      optsRef.current = opts ?? null;
      transcriptRef.current = opts?.prefill ?? "";
      setTranscript(transcriptRef.current);
      setPulseColorIndex(Math.floor(Math.random() * PULSE_PALETTES.length));
      setIsCapturing(true);

      const apply = (text: string) => {
        transcriptRef.current = text;
        setTranscript(text);
        opts?.onUpdate?.(text);
      };

      const result = engine.start({
        onPartial: apply,
        onFinal: apply,
        onError: () => {
          // Overlay stays open so user can still Cancel / Done; engine itself bailed.
        },
      });
      if (result instanceof Promise) {
        result
          .then((h) => {
            handleRef.current = h;
          })
          .catch(() => {
            // swallow — onError already fired through callbacks
          });
      } else {
        handleRef.current = result;
      }
    },
    [engine],
  );

  const value = useMemo<VoiceContextValue>(
    () => ({ startCapture, isCapturing }),
    [startCapture, isCapturing],
  );

  const palette = PULSE_PALETTES[pulseColorIndex % PULSE_PALETTES.length];

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
              onClick={() => finishCapture(false)}
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
                  onClick={() => finishCapture(false)}
                  className="relative rounded-full bg-foreground flex items-center justify-center text-background shadow-xl"
                  style={{ width: 60, height: 60 }}
                  aria-label="Stop listening"
                >
                  <Mic size={22} strokeWidth={1.8} />
                </button>
              </div>
              <p className="text-[14px] text-foreground/60 min-h-[22px] font-medium mb-5 px-8 text-center">
                {transcript || "Listening..."}
              </p>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => finishCapture(false)}
                  className="text-[13px] text-foreground/60 hover:text-foreground/80 transition-colors flex items-center gap-1.5 px-5 py-1.5 rounded-full border border-foreground/12 bg-foreground/5"
                >
                  <X size={13} strokeWidth={2} /> Cancel
                </button>
                <button
                  onClick={() => finishCapture(true)}
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
