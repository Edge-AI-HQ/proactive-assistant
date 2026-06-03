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

// Transient transcription failures used to bubble straight back to
// handleCaptureReady. The caller then kept the WAV on disk and waited for
// the next refresh() (typically only triggered on app foreground) before
// retrying. A 429 burst during heavy use therefore meant minutes of
// "Transcription unavailable" in the live widget for no good reason.
// Two short retries fold the common transient cases (network blip / 429 /
// 5xx) back into a single user-visible call without touching the
// recovery loop.
const RETRY_DELAYS_MS = [300, 1_000] as const;

export const __testHelpers = {
  isRetryableTranscribeError,
};

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
      const result = await withTranscribeRetry(() =>
        transcribeVoiceAudioDiarized(audio, { language }),
      );
      return { ...result, event };
    } catch {
      const text = await withTranscribeRetry(() =>
        transcribeVoiceAudio(audio, { language }),
      );
      return plainResult(event, text, "fallback_plain_text");
    }
  }

  const text = await withTranscribeRetry(() =>
    transcribeVoiceAudio(audio, { language }),
  );
  return plainResult(event, text, disabledStatus);
}

async function withTranscribeRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (i === RETRY_DELAYS_MS.length || !isRetryableTranscribeError(err)) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.warn("[ambient] transcription retry", {
        attempt: i + 1,
        nextDelayMs: RETRY_DELAYS_MS[i],
        error: err instanceof Error ? err.message : String(err),
      });
      await delay(RETRY_DELAYS_MS[i]);
    }
  }
  throw lastErr;
}

// The /voice/transcribe* helpers throw plain Errors with the status code
// embedded as the first token after "failed:" (e.g. "...failed: 429 rate
// limited"). Network-level failures surface as TypeError("Failed to fetch")
// from fetch() itself, so we treat any TypeError as retryable too.
function isRetryableTranscribeError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof Error)) return false;
  const match = err.message.match(/failed:\s*(\d{3})/);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 429 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
