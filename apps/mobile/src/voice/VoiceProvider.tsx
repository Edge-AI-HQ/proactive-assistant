import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { EventSubscription } from "expo-modules-core";

import { AmbientAudio, type CaptureReadyEvent } from "../../modules/ambient-audio";
import { appendVoiceTranscript } from "./text";
import { transcribeCaptureReadyEvent } from "./native-transcription";
import type { StartCaptureOptions, VoiceCaptureStatus, VoiceInputContextValue } from "./types";

const VoiceContext = createContext<VoiceInputContextValue | null>(null);

export function useVoiceInput(): VoiceInputContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoiceInput must be used inside <VoiceProvider>");
  return ctx;
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [captureStatus, setCaptureStatus] = useState<VoiceCaptureStatus>("idle");
  const optionsRef = useRef<StartCaptureOptions | null>(null);
  const transcriptRef = useRef("");
  const seqRef = useRef(0);
  const subsRef = useRef<EventSubscription[]>([]);
  const startedByVoiceRef = useRef(false);
  const seenWavIdsRef = useRef(new Set<string>());
  const pendingTranscriptionsRef = useRef(0);
  const lastCaptureActivityAtRef = useRef(0);

  const cleanup = useCallback(() => {
    for (const sub of subsRef.current) sub.remove();
    subsRef.current = [];
    optionsRef.current = null;
    seenWavIdsRef.current.clear();
    pendingTranscriptionsRef.current = 0;
    lastCaptureActivityAtRef.current = 0;
  }, []);

  const applyTranscript = useCallback((text: string, wavId?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (wavId) {
      if (seenWavIdsRef.current.has(wavId)) return;
      seenWavIdsRef.current.add(wavId);
    }
    transcriptRef.current = appendVoiceTranscript(transcriptRef.current, trimmed);
    optionsRef.current?.onUpdate?.(transcriptRef.current);
  }, []);

  const stopNativeCapture = useCallback(
    async (commit: boolean) => {
      const seq = seqRef.current;
      const opts = optionsRef.current;
      try {
        if (startedByVoiceRef.current) await AmbientAudio.stopCapture().catch(() => {});
        if (commit) await waitForTranscriptionSettle(pendingTranscriptionsRef, lastCaptureActivityAtRef);
      } finally {
        if (commit && seqRef.current === seq) opts?.onResult?.(transcriptRef.current.trim());
        seqRef.current += 1;
        setCaptureStatus("idle");
        startedByVoiceRef.current = false;
        cleanup();
      }
    },
    [cleanup],
  );

  const startNativeCapture = useCallback(
    async (seq: number, options: StartCaptureOptions | null) => {
      try {
        if (captureStatus !== "idle") {
          await stopNativeCapture(false);
          seqRef.current = seq;
        }
        cleanup();
        optionsRef.current = options;
        transcriptRef.current = options?.prefill ?? "";
        setCaptureStatus("connecting");

        const permissions = await AmbientAudio.requestPermissions();
        if (permissions.microphone !== "granted") {
          throw new Error("Microphone permission denied");
        }

        const state = await AmbientAudio.getState().catch(() => null);
        startedByVoiceRef.current = !(state?.running || state?.capturing || state?.capturePipelineRunning);
        if (startedByVoiceRef.current) {
          await AmbientAudio.configure({
            cloudMode: "off",
            minBurstMs: 250,
            postRollMs: 450,
            maxBurstMs: 30_000,
            sessionSilenceGapMs: 650,
          });
        }

        subsRef.current = [
          AmbientAudio.addListener("captureReady", (event: CaptureReadyEvent) => {
            if (seqRef.current !== seq) return;
            pendingTranscriptionsRef.current += 1;
            lastCaptureActivityAtRef.current = Date.now();
            void transcribeCaptureReadyEvent(event)
              .then((text) => {
                if (seqRef.current !== seq) return;
                applyTranscript(text, event.wavId);
              })
              .catch((err) => {
                if (seqRef.current !== seq) return;
                optionsRef.current?.onError?.(voiceErrorMessage(err));
              })
              .finally(() => {
                pendingTranscriptionsRef.current = Math.max(0, pendingTranscriptionsRef.current - 1);
                lastCaptureActivityAtRef.current = Date.now();
              });
          }),
          AmbientAudio.addListener("audioError", (event: { message: string }) => {
            if (seqRef.current !== seq) return;
            optionsRef.current?.onError?.(event.message);
          }),
        ];

        if (startedByVoiceRef.current) await AmbientAudio.startCapture();
        if (seqRef.current === seq) setCaptureStatus("listening");
      } catch (err) {
        if (seqRef.current === seq) {
          options?.onError?.(voiceErrorMessage(err));
          setCaptureStatus("idle");
          cleanup();
        }
      }
    },
    [applyTranscript, captureStatus, cleanup, stopNativeCapture],
  );

  const startCapture = useCallback(
    (options?: StartCaptureOptions) => {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      void startNativeCapture(seq, options ?? null);
    },
    [startNativeCapture],
  );

  const stopCapture = useCallback(
    async (commit: boolean) => {
      await stopNativeCapture(commit);
    },
    [stopNativeCapture],
  );

  const value = useMemo<VoiceInputContextValue>(
    () => ({
      startCapture,
      stopCapture,
      isCapturing: captureStatus !== "idle",
      captureStatus,
    }),
    [captureStatus, startCapture, stopCapture],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

async function waitForTranscriptionSettle(
  pendingRef: MutableRefObject<number>,
  lastActivityRef: MutableRefObject<number>,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const pending = pendingRef.current > 0;
    const recentlyActive = lastActivityRef.current > 0 && Date.now() - lastActivityRef.current < 500;
    if (!pending && !recentlyActive) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

function voiceErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Voice transcription failed";
}
