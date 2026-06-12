/**
 * ambient-audio（Expo local module）JS 绑定：后台音频采集 + Silero VAD
 * 分段 + SoundAnalysis 分类 + Apple Speech 转写（可选 cloud refine）。
 * Swift 核心 9 类原样迁移自 capacitor-plugins/ambient-ai（零 Capacitor
 * 依赖），方法面与原 AudioCapturePlugin 1:1。
 */
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export interface SoundClassificationEvent {
  classifications: { label: string; confidence: number }[];
  timestamp: number;
}

export interface CaptureReadyEvent {
  wavId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  byteSize: number;
  sessionId?: string;
}

export interface TranscriptEvent {
  text: string;
  startedAt: number;
  endedAt: number;
  wavId?: string;
  provider?: string;
  sessionId?: string;
}

export interface SpeechBurstEvent {
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface AudioStateEvent {
  running: boolean;
  paused: boolean;
  capturing: boolean;
  classificationRunning: boolean;
  engineRunning: boolean;
  capturePipelineRunning: boolean;
  engineState: string;
  classifierRestartCount: number;
  suppressed: boolean;
  route?: string;
  reason?: string;
}

export interface AudioErrorEvent {
  message: string;
  source: string;
}

export interface AudioConfig {
  recognitionLocale?: string;
  cloudMode?: "off" | "refine";
  cloudApiKey?: string;
  cloudBaseURL?: string;
  modelName?: string;
  cloudRefineTimeoutMs?: number;
  preRollMs?: number;
  postRollMs?: number;
  maxBurstMs?: number;
  minBurstMs?: number;
  sessionSilenceGapMs?: number;
  maxSessionDurationMs?: number;
  wavRetentionTtlMs?: number;
  wavMaxBytes?: number;
  wavMaxFiles?: number;
}

type AudioEventName =
  | "soundClassification"
  | "captureReady"
  | "transcript"
  | "speechBurst"
  | "audioState"
  | "audioError";

interface AmbientAudioModuleType {
  requestPermissions(): Promise<{ microphone: string; speechRecognition: string }>;
  checkPermissions(): Promise<{ microphone: string; speechRecognition: string }>;
  configure(options: AudioConfig): Promise<void>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  getState(): Promise<AudioStateEvent>;
  drainPendingTranscripts(): Promise<{ transcripts: TranscriptEvent[] }>;
  listRecentCaptures(
    limit?: number | null,
    cursor?: string | null,
    order?: "asc" | "desc" | null,
  ): Promise<{ captures: CaptureReadyEvent[] }>;
  readCapture(wavId: string): Promise<{ wavId: string; contentType: string; base64: string; byteSize: number }>;
  markCaptureProcessed(wavId: string): Promise<void>;
  playCapture(wavId: string): Promise<void>;
  stopPlayback(): Promise<void>;
  startClassification(): Promise<void>;
  stopClassification(): Promise<void>;
  setExternalMicSuppressed(suppressed: boolean): Promise<void>;
  addListener(eventName: AudioEventName, listener: (event: never) => void): EventSubscription;
}

// 同 ambient-visit：Swift 未链接的 build 里 import 安全，调用时才抛。
export const AmbientAudio =
  requireOptionalNativeModule<AmbientAudioModuleType>("AmbientAudio") ??
  (new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `AmbientAudio native module unavailable (Swift core not linked in this build): ${String(prop)}`,
        );
      },
    },
  ) as AmbientAudioModuleType);
