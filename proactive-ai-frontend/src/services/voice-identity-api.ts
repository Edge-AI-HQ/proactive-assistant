import { proxyFetch } from "@pin-ai/core";

export interface VoiceIdentityProfile {
  enabled: boolean;
  enrolledAt: string | null;
  updatedAt: string | null;
  speakerName: "self";
  referenceDurationMs: number | null;
  referenceByteLen: number | null;
  referenceSha256?: string;
}

export interface SpeakerSegment {
  speaker: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

export type DiarizationStatus =
  | "matched_reference"
  | "diarized_without_reference"
  | "fallback_plain_text"
  | "disabled"
  | "not_enrolled";

export interface DiarizedVoiceTranscriptionResult {
  text: string;
  selfText: string;
  speakerLabels: string[];
  segments: SpeakerSegment[];
  provider: "cloud_diarize";
  diarizationStatus: DiarizationStatus;
  diarizationModel: "gpt-4o-transcribe-diarize";
}

interface VoiceIdentityResponse {
  ok?: boolean;
  profile?: VoiceIdentityProfile | null;
}

interface DiarizedTranscriptionResponse {
  ok?: boolean;
  text?: unknown;
  selfText?: unknown;
  speakerLabels?: unknown;
  segments?: unknown;
  diarizationStatus?: unknown;
  diarizationModel?: unknown;
}

export async function fetchVoiceIdentity(
  signal?: AbortSignal,
): Promise<VoiceIdentityProfile | null> {
  const res = await proxyFetch("/voice/identity", signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`/voice/identity failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as VoiceIdentityResponse;
  return data.profile ?? null;
}

export async function uploadVoiceIdentityReference(
  audio: Blob,
  durationMs: number,
): Promise<VoiceIdentityProfile | null> {
  const res = await proxyFetch("/voice/identity/reference", {
    method: "POST",
    headers: {
      "Content-Type": audio.type || "audio/wav",
      "X-Audio-Duration-Ms": String(Math.round(durationMs)),
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`/voice/identity/reference failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as VoiceIdentityResponse;
  return data.profile ?? null;
}

export async function setVoiceIdentityEnabled(enabled: boolean): Promise<VoiceIdentityProfile | null> {
  const res = await proxyFetch("/voice/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`/voice/identity failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as VoiceIdentityResponse;
  return data.profile ?? null;
}

export async function deleteVoiceIdentityReference(): Promise<void> {
  const res = await proxyFetch("/voice/identity/reference", {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`/voice/identity/reference failed: ${await readErrorMessage(res)}`);
}

export async function transcribeVoiceAudioDiarized(
  audio: Blob,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<DiarizedVoiceTranscriptionResult> {
  const params = new URLSearchParams();
  if (options.language) params.set("language", options.language);
  const path = `/voice/transcribe-diarized${params.size > 0 ? `?${params.toString()}` : ""}`;
  const res = await proxyFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": audio.type || "audio/wav",
      "X-Audio-Filename": filenameForAudio(audio),
    },
    body: audio,
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`/voice/transcribe-diarized failed: ${await readErrorMessage(res)}`);

  const data = (await res.json()) as DiarizedTranscriptionResponse;
  if (typeof data.text !== "string") {
    throw new Error("/voice/transcribe-diarized response missing text");
  }
  return {
    text: data.text.trim(),
    selfText: typeof data.selfText === "string" ? data.selfText.trim() : "",
    speakerLabels: stringArray(data.speakerLabels),
    segments: normalizeSegments(data.segments),
    provider: "cloud_diarize",
    diarizationStatus: normalizeDiarizationStatus(data.diarizationStatus),
    diarizationModel: "gpt-4o-transcribe-diarize",
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? `${res.status} ${text}` : `${res.status}`;
  } catch {
    return `${res.status}`;
  }
}

function filenameForAudio(audio: Blob): string {
  const contentType = audio.type.split(";")[0].trim().toLowerCase();
  if (contentType === "audio/mp4") return "voice-input.mp4";
  if (contentType === "audio/mpeg") return "voice-input.mp3";
  if (contentType === "audio/wav") return "voice-input.wav";
  if (contentType === "video/webm") return "voice-input.webm";
  return "voice-input.webm";
}

function normalizeSegments(value: unknown): SpeakerSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SpeakerSegment[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || !row.text.trim()) return [];
    return [{
      speaker: typeof row.speaker === "string" && row.speaker.trim() ? row.speaker.trim() : "other",
      text: row.text.trim(),
      startMs: typeof row.startMs === "number" ? row.startMs : null,
      endMs: typeof row.endMs === "number" ? row.endMs : null,
    }];
  });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeDiarizationStatus(value: unknown): DiarizationStatus {
  switch (value) {
    case "matched_reference":
    case "diarized_without_reference":
    case "fallback_plain_text":
    case "disabled":
    case "not_enrolled":
      return value;
    default:
      return "diarized_without_reference";
  }
}
