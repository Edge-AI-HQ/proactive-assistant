import {
  AmbientAi,
  type CaptureReadyEvent,
} from "@pin/capacitor-ambient-ai";
import { transcribeVoiceAudio } from "@/components/voice/transcriptionApi";

export interface CaptureTranscriptionResult {
  text: string;
  event: CaptureReadyEvent;
}

export async function transcribeAmbientCapture(
  event: CaptureReadyEvent,
  language = "zh-CN",
): Promise<CaptureTranscriptionResult> {
  const capture = await AmbientAi.audio.readCapture({ wavId: event.wavId });
  const audio = base64ToBlob(capture.base64, capture.contentType);
  const text = await transcribeVoiceAudio(audio, { language });
  return { text: text.trim(), event };
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType || "audio/wav" });
}
