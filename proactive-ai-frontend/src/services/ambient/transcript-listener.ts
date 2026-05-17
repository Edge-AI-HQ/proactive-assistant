import type { PluginListenerHandle } from "@capacitor/core";
import {
  AmbientAi,
  type AudioState,
  type SpeechBurstEvent,
  type TranscriptDraftEvent,
  type TranscriptRefinedEvent,
  type TranscriptReadyEvent,
} from "@pin/capacitor-ambient-ai";

export type AmbientLiveTranscriptEvent =
  | { type: "audioState"; event: AudioState }
  | { type: "speechBurst"; event: SpeechBurstEvent }
  | { type: "transcriptDraft"; event: TranscriptDraftEvent }
  | { type: "transcriptReady"; event: TranscriptReadyEvent }
  | { type: "transcriptRefined"; event: TranscriptRefinedEvent };

export function addAmbientTranscriptListener(
  listener: (event: TranscriptReadyEvent) => void,
): Promise<PluginListenerHandle> {
  return AmbientAi.addListener("transcriptReady", listener);
}

export async function addAmbientLiveTranscriptListeners(
  listener: (event: AmbientLiveTranscriptEvent) => void,
): Promise<PluginListenerHandle> {
  const handles = await Promise.all([
    AmbientAi.addListener("audioState", (event) => listener({ type: "audioState", event })),
    AmbientAi.addListener("speechBurst", (event) => listener({ type: "speechBurst", event })),
    AmbientAi.addListener("transcriptDraft", (event) => listener({ type: "transcriptDraft", event })),
    AmbientAi.addListener("transcriptReady", (event) => listener({ type: "transcriptReady", event })),
    AmbientAi.addListener("transcriptRefined", (event) => listener({ type: "transcriptRefined", event })),
  ]);
  return {
    remove: async () => {
      await Promise.all(handles.map((handle) => handle.remove()));
    },
  };
}
