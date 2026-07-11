import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import i18n from "../i18n";
import { ByteDanceStreamingEngine } from "./ByteDanceStreamingEngine";
import { normalizeVoiceLanguage } from "./language";
import type {
  StartCaptureOptions,
  VoiceCaptureStatus,
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

export function VoiceProvider({ children, engine, transcriptionLanguage }: VoiceProviderProps) {
  const [captureStatus, setCaptureStatus] = useState<VoiceCaptureStatus>("idle");

  const handleRef = useRef<VoiceEngineHandle | null>(null);
  const optsRef = useRef<StartCaptureOptions | null>(null);
  const transcriptRef = useRef("");
  const captureSeqRef = useRef(0);
  const voiceLanguage = useMemo(
    () => normalizeVoiceLanguage(transcriptionLanguage),
    [transcriptionLanguage],
  );
  const activeEngine = useMemo<VoiceEngine>(
    () => engine ?? new ByteDanceStreamingEngine({
      language: voiceLanguage.openai,
    }),
    [engine, voiceLanguage.openai],
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
        await stopResult;
      }
    } catch {
      completed = false;
      // The engine has already surfaced the error via onError. Close cleanly
      // so the input is left in its last known state.
    } finally {
      const finalText = transcriptRef.current;
      optsRef.current = null;
      setCaptureStatus("idle");
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
      setCaptureStatus("connecting");

      const apply = (text: string) => {
        if (captureSeqRef.current !== seq) return;
        transcriptRef.current = text;
        opts?.onUpdate?.(text);
      };

      const result = activeEngine.start({
        onPartial: apply,
        onFinal: apply,
        onReady: () => {
          if (captureSeqRef.current !== seq) return;
          setCaptureStatus("listening");
        },
        onError: (err) => {
          const message = voiceErrorMessage(err);
          if (captureSeqRef.current === seq) setCaptureStatus("listening");
          opts?.onError?.(message);
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
            if (!activeEngine.reportsReady) setCaptureStatus("listening");
          })
          .catch(() => {
            // swallow — onError already fired through callbacks
          });
      } else {
        handleRef.current = result;
        if (!activeEngine.reportsReady) setCaptureStatus("listening");
      }
    },
    [activeEngine],
  );

  const isCapturing = captureStatus !== "idle";
  const value = useMemo<VoiceContextValue>(
    () => ({ startCapture, stopCapture: finishCapture, isCapturing, captureStatus }),
    [startCapture, finishCapture, isCapturing, captureStatus],
  );

  return (
    <VoiceContext.Provider value={value}>
      {children}
    </VoiceContext.Provider>
  );
}

function voiceErrorMessage(err: unknown): string {
  // Engine-thrown Error messages pass through untranslated (error-code i18n
  // is a bigger refactor); only this UI-owned fallback is translated.
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return i18n.t("voice:errors.transcriptionFailed");
}

function isPromiseLike(value: void | Promise<void> | undefined): value is Promise<void> {
  return Boolean(value && typeof value.then === "function");
}
