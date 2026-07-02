/**
 * RN 实时转写事件桥 —— dev services/ambient/transcript-listener.ts 的对应物。
 * 订阅 ambient-audio Expo 模块的原生事件（Apple Speech ASR），归一成
 * AmbientLiveTranscriptEvent 交给 live-transcript-store。事件 payload 形状取自
 * modules/ambient-audio/ios（TranscriptReadyRecord / emitTranscriptDraft /
 * emitTranscriptRefined / CaptureSessionRotatedRecord）。
 */
import type { EventSubscription } from "expo-modules-core";

import { AmbientAudio, type AudioStateEvent, type SpeechBurstEvent } from "../../../modules/ambient-audio";

export interface TranscriptReadyEvent {
  captureSessionId: string;
  burstId: string;
  text: string;
  provider?: string;
}

export interface TranscriptDraftEvent {
  captureSessionId: string;
  burstId: string;
  text: string;
}

export interface TranscriptRefinedEvent {
  captureSessionId: string;
  burstId: string;
  refinedText: string;
  provider?: string;
}

export interface CaptureSessionRotatedEvent {
  oldCaptureSessionId: string;
  newCaptureSessionId: string;
  reason: string;
  rotatedAt: string;
}

export type AmbientLiveTranscriptEvent =
  | { type: "audioState"; event: AudioStateEvent }
  | { type: "captureSessionRotated"; event: CaptureSessionRotatedEvent }
  | { type: "speechBurst"; event: SpeechBurstEvent }
  | { type: "transcriptDraft"; event: TranscriptDraftEvent }
  | { type: "transcriptReady"; event: TranscriptReadyEvent }
  | { type: "transcriptRefined"; event: TranscriptRefinedEvent };

// 原生模块把 addListener 的 payload 定为 never（未逐事件定型）→ 在边界处 cast 成
// 上面已知形状（对齐 Swift 侧 payload 字段，非 as any）。
export function addAmbientLiveTranscriptListeners(
  listener: (event: AmbientLiveTranscriptEvent) => void,
): { remove: () => void } {
  const subs: EventSubscription[] = [
    AmbientAudio.addListener("audioState", (e) =>
      listener({ type: "audioState", event: e as AudioStateEvent }),
    ),
    AmbientAudio.addListener("captureSessionRotated", (e) =>
      listener({ type: "captureSessionRotated", event: e as CaptureSessionRotatedEvent }),
    ),
    AmbientAudio.addListener("speechBurst", (e) =>
      listener({ type: "speechBurst", event: e as SpeechBurstEvent }),
    ),
    AmbientAudio.addListener("transcriptDraft", (e) =>
      listener({ type: "transcriptDraft", event: e as TranscriptDraftEvent }),
    ),
    AmbientAudio.addListener("transcriptReady", (e) =>
      listener({ type: "transcriptReady", event: e as TranscriptReadyEvent }),
    ),
    AmbientAudio.addListener("transcriptRefined", (e) =>
      listener({ type: "transcriptRefined", event: e as TranscriptRefinedEvent }),
    ),
  ];
  return {
    remove: () => {
      for (const sub of subs) sub.remove();
    },
  };
}
