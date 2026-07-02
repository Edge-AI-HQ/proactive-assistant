import { EncodingType, File, Paths, UploadType } from "expo-file-system";
import { getTransportConfig } from "@pin-ai/core";

import { AmbientAudio, type CaptureReadyEvent } from "../../modules/ambient-audio";

export async function transcribeCaptureReadyEvent(event: CaptureReadyEvent): Promise<string> {
  // 静态 import(见 App.tsx 注释):dynamic import() 在本 Hermes/Metro setup 跑不通。
  const capture = await AmbientAudio.readCapture(event.wavId);
  const file = writeCaptureTempFile(capture);
  try {
    return await transcribeVoiceFile(file, capture.contentType);
  } finally {
    try {
      file.delete();
    } catch {
      // Best-effort cache cleanup only.
    }
  }
}

async function transcribeVoiceFile(file: File, contentType: string): Promise<string> {
  const cfg = getTransportConfig();
  const headers = {
    ...(cfg.defaultHeaders ?? {}),
    ...(await cfg.getAuthHeaders()),
    "Content-Type": contentType || "audio/wav",
    "X-Audio-Filename": filenameForContentType(contentType),
  };
  let result = await uploadVoiceFile(file, `${cfg.baseUrl}/api/voice/transcribe`, headers, contentType);
  if (result.status === 401 && cfg.refreshAuth) {
    const token = await cfg.refreshAuth();
    if (token) {
      result = await uploadVoiceFile(
        file,
        `${cfg.baseUrl}/api/voice/transcribe`,
        { ...headers, Authorization: `Bearer ${token}` },
        contentType,
      );
    }
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`/voice/transcribe failed: ${result.status} ${result.body}`);
  }
  const data = JSON.parse(result.body) as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("/voice/transcribe response missing text");
  }
  return data.text.trim();
}

async function uploadVoiceFile(
  file: File,
  url: string,
  headers: Record<string, string>,
  contentType: string,
) {
  return file.upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers,
    mimeType: contentType || "audio/wav",
    sessionType: "foreground",
  });
}

function writeCaptureTempFile(capture: {
  wavId: string;
  base64: string;
}): File {
  const file = new File(Paths.cache, `voice-input-${capture.wavId}.wav`);
  file.create({ overwrite: true });
  file.write(capture.base64, { encoding: EncodingType.Base64 });
  return file;
}

function filenameForContentType(contentType: string): string {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType === "audio/mp4") return "voice-input.mp4";
  if (mediaType === "audio/mpeg") return "voice-input.mp3";
  return "voice-input.wav";
}
