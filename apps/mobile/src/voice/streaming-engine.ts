import {
  ByteDanceVoiceStreamSession,
  getTransportConfig,
  type VoicePcmStreamRecorder,
  type VoicePcmStreamRecorderOptions,
  type VoiceStreamAuthMessage,
  type VoiceStreamCallbacks,
  type VoiceStreamHandle,
  type VoiceStreamSocket,
} from "@pin-ai/core";
import type { EventSubscription } from "expo-modules-core";

import { AmbientAudio, type VoicePcmChunkEvent } from "../../modules/ambient-audio";

interface NativeByteDanceStreamingEngineOptions {
  language?: string;
  finalTimeoutMs?: number;
  socketFactory?: (url: string) => WebSocket;
  urlProvider?: () => Promise<string>;
  authMessageProvider?: () => Promise<VoiceStreamAuthMessage>;
}

export class NativeByteDanceStreamingEngine {
  readonly reportsReady = true;

  private readonly language?: string;
  private readonly finalTimeoutMs?: number;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly urlProvider?: () => Promise<string>;
  private readonly authMessageProvider: () => Promise<VoiceStreamAuthMessage>;

  constructor(options: NativeByteDanceStreamingEngineOptions = {}) {
    this.language = options.language?.trim() || undefined;
    this.finalTimeoutMs = options.finalTimeoutMs;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.urlProvider = options.urlProvider;
    this.authMessageProvider = options.authMessageProvider ?? buildVoiceStreamAuthMessage;
  }

  start(callbacks: VoiceStreamCallbacks): Promise<VoiceStreamHandle> {
    const session = new ByteDanceVoiceStreamSession({
      finalTimeoutMs: this.finalTimeoutMs,
      socketFactory: (url) => this.socketFactory(url) as unknown as VoiceStreamSocket,
      recorderFactory: createNativePcmStreamRecorder,
      urlProvider: this.urlProvider ?? (() => buildVoiceStreamUrl({ language: this.language })),
      authMessageProvider: this.authMessageProvider,
    });
    return session.start(callbacks);
  }
}

async function createNativePcmStreamRecorder(
  options: VoicePcmStreamRecorderOptions,
): Promise<VoicePcmStreamRecorder> {
  let streamId: string | null = null;
  let subscription: EventSubscription | null = null;
  try {
    subscription = AmbientAudio.addListener("voicePcmChunk", (event: VoicePcmChunkEvent) => {
      if (!streamId || event.streamId !== streamId) return;
      options.onChunk(base64ToArrayBuffer(event.base64));
    });
    const started = await AmbientAudio.startVoicePcmStream({
      sampleRate: options.sampleRate ?? 16_000,
      chunkDurationMs: options.chunkDurationMs ?? 100,
    });
    streamId = started.streamId;
  } catch (err) {
    subscription?.remove();
    throw err;
  }

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await AmbientAudio.stopVoicePcmStream(streamId);
        // stopVoicePcmStream flushes the native tail chunk through the event
        // queue; keep the listener briefly so that final partial audio is not
        // dropped before core sends the stream end frame.
        await delay(80);
      } finally {
        subscription?.remove();
      }
    },
  };
}

interface BuildVoiceStreamUrlOptions {
  language?: string;
}

async function buildVoiceStreamUrl(options: BuildVoiceStreamUrlOptions = {}): Promise<string> {
  const cfg = getTransportConfig();
  const url = new URL("/api/voice/transcribe-stream", cfg.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const language = options.language?.trim();
  if (language) url.searchParams.set("language", language);

  return url.toString();
}

async function buildVoiceStreamAuthMessage(): Promise<VoiceStreamAuthMessage> {
  const headers = await getTransportConfig().getAuthHeaders();
  const authorization = headers.Authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return { type: "auth", token: authorization.slice("Bearer ".length) };
  }
  const devAuth = headers["X-Dev-Auth"];
  if (devAuth) return { type: "auth", dev_auth: devAuth };

  return { type: "auth" };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const byteLength = Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(clean[i] ?? "A");
    const b = BASE64_ALPHABET.indexOf(clean[i + 1] ?? "A");
    const c = clean[i + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(clean[i + 2] ?? "A");
    const d = clean[i + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(clean[i + 3] ?? "A");
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error("invalid base64 PCM chunk");
    }

    if (offset < byteLength) bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < byteLength) bytes[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < byteLength) bytes[offset++] = ((c & 3) << 6) | d;
  }
  return buffer;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
