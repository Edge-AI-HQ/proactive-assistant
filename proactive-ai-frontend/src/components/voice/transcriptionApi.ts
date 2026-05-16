import { proxyFetch } from "@/lib/api";

export interface TranscribeVoiceAudioOptions {
  model?: string;
  language?: string;
  signal?: AbortSignal;
}

interface TranscribeVoiceAudioResponse {
  ok?: boolean;
  text?: unknown;
}

export async function transcribeVoiceAudio(
  audio: Blob,
  options: TranscribeVoiceAudioOptions = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (options.model) params.set("model", options.model);
  if (options.language) params.set("language", options.language);

  const path = `/voice/transcribe${params.size > 0 ? `?${params.toString()}` : ""}`;
  const res = await proxyFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": audio.type || "audio/webm",
      "X-Audio-Filename": filenameForAudio(audio),
    },
    body: audio,
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`/voice/transcribe failed: ${await readErrorMessage(res)}`);
  }

  const data = (await res.json()) as TranscribeVoiceAudioResponse;
  if (typeof data.text !== "string") {
    throw new Error("/voice/transcribe response missing text");
  }
  return data.text.trim();
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
