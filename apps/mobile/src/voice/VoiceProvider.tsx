import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { normalizeVoiceLanguage, type ExternalMicLease, type VoiceStreamHandle } from "@pin-ai/core";

import { AmbientAudio } from "../../modules/ambient-audio";
import { acquireExternalMic } from "../ambient/external-mic";
import { appendVoiceTranscript } from "./text";
import { transcribeVoiceFileUri } from "./native-transcription";
import { WAV_RECORDING_OPTIONS } from "./recording";
import { NativeByteDanceStreamingEngine } from "./streaming-engine";
import type { StartCaptureOptions, VoiceCaptureStatus, VoiceInputContextValue } from "./types";

const VoiceContext = createContext<VoiceInputContextValue | null>(null);

export function useVoiceInput(): VoiceInputContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoiceInput must be used inside <VoiceProvider>");
  return ctx;
}

type CaptureMode = "streaming" | "batch";

interface VoiceProviderProps {
  children: ReactNode;
  transcriptionLanguage?: string | null;
}

export function VoiceProvider({ children, transcriptionLanguage = null }: VoiceProviderProps) {
  const [captureStatus, setCaptureStatus] = useState<VoiceCaptureStatus>("idle");
  const optionsRef = useRef<StartCaptureOptions | null>(null);
  const transcriptRef = useRef("");
  const baseTranscriptRef = useRef("");
  const seqRef = useRef(0);
  const modeRef = useRef<CaptureMode | null>(null);
  const streamHandleRef = useRef<VoiceStreamHandle | null>(null);
  const leaseRef = useRef<ExternalMicLease | null>(null);

  const voiceLanguage = useMemo(
    () => normalizeVoiceLanguage(transcriptionLanguage),
    [transcriptionLanguage],
  );

  const recorder = useAudioRecorder(WAV_RECORDING_OPTIONS);

  const cleanup = useCallback(() => {
    optionsRef.current = null;
    modeRef.current = null;
    streamHandleRef.current = null;
    void leaseRef.current?.release();
    leaseRef.current = null;
  }, []);

  const applyTranscript = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const next = appendVoiceTranscript(baseTranscriptRef.current, trimmed);
    transcriptRef.current = next;
    optionsRef.current?.onUpdate?.(next);
  }, []);

  const releaseLease = useCallback(async () => {
    await leaseRef.current?.release();
    leaseRef.current = null;
  }, []);

  const stopBatchCapture = useCallback(
    async (commit: boolean, seq: number, opts: StartCaptureOptions | null): Promise<boolean> => {
      let completed = true;
      let uri: string | null = null;
      try {
        await recorder.stop();
        uri = recorder.uri;
      } catch (err) {
        completed = false;
        if (commit && seqRef.current === seq) opts?.onError?.(voiceErrorMessage(err));
      } finally {
        await releaseLease();
      }

      if (commit && uri) {
        try {
          const text = await transcribeVoiceFileUri(uri, { language: voiceLanguage.openai });
          if (seqRef.current === seq) applyTranscript(text);
        } catch (err) {
          completed = false;
          if (seqRef.current === seq) opts?.onError?.(voiceErrorMessage(err));
        }
      }
      if (uri) {
        try {
          new File(uri).delete();
        } catch {
          // Best-effort cache cleanup only.
        }
      }
      return completed;
    },
    [applyTranscript, recorder, releaseLease, voiceLanguage.openai],
  );

  const stopStreamingCapture = useCallback(
    async (commit: boolean, seq: number, opts: StartCaptureOptions | null): Promise<boolean> => {
      const handle = streamHandleRef.current;
      let completed = true;
      try {
        const stopResult = commit
          ? handle?.stop()
          : handle?.cancel ? handle.cancel() : handle?.stop();
        if (isPromiseLike(stopResult)) await stopResult;
      } catch (err) {
        completed = false;
        if (commit && seqRef.current === seq) opts?.onError?.(voiceErrorMessage(err));
      } finally {
        await releaseLease();
      }
      return completed;
    },
    [releaseLease],
  );

  const stopNativeCapture = useCallback(
    async (commit: boolean) => {
      const seq = seqRef.current;
      const opts = optionsRef.current;
      const mode = modeRef.current;
      let completed = true;
      try {
        if (mode === "streaming") {
          completed = await stopStreamingCapture(commit, seq, opts);
        } else if (mode === "batch") {
          completed = await stopBatchCapture(commit, seq, opts);
        } else {
          await releaseLease();
        }
      } finally {
        if (commit && completed && seqRef.current === seq) {
          opts?.onResult?.(transcriptRef.current.trim());
        }
        seqRef.current += 1;
        setCaptureStatus("idle");
        cleanup();
      }
    },
    [cleanup, releaseLease, stopBatchCapture, stopStreamingCapture],
  );

  const startBatchFallback = useCallback(
    async (seq: number, options: StartCaptureOptions | null) => {
      modeRef.current = "batch";
      leaseRef.current = await acquireExternalMic();
      if (seqRef.current !== seq) {
        await releaseLease();
        return;
      }

      let prepared = false;
      let lastPrepErr: unknown = null;
      for (const wait of [0, 250, 600, 1200]) {
        if (seqRef.current !== seq) return;
        if (wait) await delay(wait);
        try {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          await recorder.prepareToRecordAsync();
          prepared = true;
          break;
        } catch (prepErr) {
          lastPrepErr = prepErr;
        }
      }
      if (!prepared) throw lastPrepErr ?? new Error("recorder failed to prepare");
      if (seqRef.current !== seq) return;
      recorder.record();
      if (seqRef.current === seq) setCaptureStatus("listening");
    },
    [recorder, releaseLease],
  );

  const startStreamingCapture = useCallback(
    async (seq: number, options: StartCaptureOptions | null) => {
      modeRef.current = "streaming";
      leaseRef.current = await acquireExternalMic();
      if (seqRef.current !== seq) {
        await releaseLease();
        return;
      }

      const engine = new NativeByteDanceStreamingEngine({ language: voiceLanguage.openai });
      const handle = await engine.start({
        onPartial: applyTranscript,
        onFinal: applyTranscript,
        onReady: () => {
          if (seqRef.current === seq) setCaptureStatus("listening");
        },
        onError: (err) => {
          if (seqRef.current !== seq) return;
          setCaptureStatus("listening");
          options?.onError?.(voiceErrorMessage(err));
        },
      });
      if (seqRef.current !== seq) {
        if (handle.cancel) await handle.cancel();
        else await handle.stop();
        await releaseLease();
        return;
      }
      streamHandleRef.current = handle;
    },
    [applyTranscript, releaseLease, voiceLanguage.openai],
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
        baseTranscriptRef.current = options?.prefill ?? "";
        transcriptRef.current = baseTranscriptRef.current;
        setCaptureStatus("connecting");

        const permissions = await AmbientAudio.requestPermissions();
        if (permissions.microphone !== "granted") {
          throw new Error("Microphone permission denied");
        }

        try {
          await startStreamingCapture(seq, options);
        } catch {
          if (seqRef.current !== seq) return;
          await releaseLease();
          await startBatchFallback(seq, options);
        }
      } catch (err) {
        if (seqRef.current === seq) {
          options?.onError?.(voiceErrorMessage(err));
          setCaptureStatus("idle");
          cleanup();
        }
      }
    },
    [captureStatus, cleanup, releaseLease, startBatchFallback, startStreamingCapture, stopNativeCapture],
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

function voiceErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Voice transcription failed";
}

function isPromiseLike(value: void | Promise<void> | undefined): value is Promise<void> {
  return Boolean(value && typeof value.then === "function");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
