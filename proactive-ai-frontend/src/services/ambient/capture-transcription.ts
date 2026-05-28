import {
  AmbientAi,
  type CaptureReadyEvent,
} from "@pin/capacitor-ambient-ai";
import { transcribeVoiceAudio } from "@/components/voice/transcriptionApi";
import {
  fetchVoiceIdentity,
  transcribeVoiceAudioDiarized,
  type DiarizationStatus,
  type SpeakerSegment,
} from "@/services/voiceIdentityApi";

export interface CaptureTranscriptionResult {
  text: string;
  event: CaptureReadyEvent;
  selfText: string;
  speakerLabels: string[];
  segments: SpeakerSegment[];
  provider: "cloud_diarize" | "cloud_whisper";
  diarizationStatus: DiarizationStatus;
  diarizationModel?: "gpt-4o-transcribe-diarize";
}

export async function transcribeAmbientCapture(
  event: CaptureReadyEvent,
  language?: string,
): Promise<CaptureTranscriptionResult> {
  const capture = await AmbientAi.audio.readCapture({ wavId: event.wavId });
  const audio = base64ToBlob(capture.base64, capture.contentType);
  let profileEnabled = false;
  let disabledStatus: DiarizationStatus = "not_enrolled";
  try {
    const profile = await fetchVoiceIdentity();
    profileEnabled = profile?.enabled === true;
    disabledStatus = profile ? "disabled" : "not_enrolled";
  } catch {
    profileEnabled = false;
    disabledStatus = "not_enrolled";
  }

  if (profileEnabled) {
    try {
      const result = await transcribeVoiceAudioDiarized(audio, { language });
      return { ...result, event };
    } catch {
      const text = await transcribeVoiceAudio(audio, { language });
      return plainResult(event, text, "fallback_plain_text");
    }
  }

  const text = await transcribeVoiceAudio(audio, { language });
  return plainResult(event, text, disabledStatus);
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType || "audio/wav" });
}

function plainResult(
  event: CaptureReadyEvent,
  text: string,
  diarizationStatus: DiarizationStatus,
): CaptureTranscriptionResult {
  return {
    text: text.trim(),
    event,
    selfText: "",
    speakerLabels: [],
    segments: [],
    provider: "cloud_whisper",
    diarizationStatus,
  };
}
