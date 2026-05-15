import type { PluginListenerHandle } from "@capacitor/core";
import {
  AmbientAi,
  type TranscriptReadyEvent,
} from "@pin/capacitor-ambient-ai";

export function addAmbientTranscriptListener(
  listener: (event: TranscriptReadyEvent) => void,
): Promise<PluginListenerHandle> {
  return AmbientAi.addListener("transcriptReady", listener);
}
