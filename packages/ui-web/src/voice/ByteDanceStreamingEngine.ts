import {
  ByteDanceVoiceStreamSession,
  type VoiceStreamAuthMessage,
  type VoiceStreamSocket,
} from "@pin-ai/core";

import type { VoiceEngine, VoiceEngineCallbacks, VoiceEngineHandle } from "./types";
import { createPcmStreamRecorder, type PcmStreamRecorder } from "./pcm-recorder";
import {
  buildVoiceStreamAuthMessage,
  buildVoiceStreamUrl,
} from "./voice-stream-api";

interface ByteDanceStreamingEngineOptions {
  language?: string;
  fallback?: VoiceEngine;
  finalTimeoutMs?: number;
  socketFactory?: (url: string) => WebSocket;
  recorderFactory?: (
    stream: MediaStream,
    options: {
      onChunk(chunk: ArrayBuffer): void;
      sampleRate?: number;
      chunkDurationMs?: number;
    },
  ) => Promise<PcmStreamRecorder>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  urlProvider?: () => Promise<string>;
  authMessageProvider?: () => Promise<VoiceStreamAuthMessage>;
}

type RecorderFactory = NonNullable<ByteDanceStreamingEngineOptions["recorderFactory"]>;

export class ByteDanceStreamingEngine implements VoiceEngine {
  readonly reportsReady = true;

  private readonly language?: string;
  private readonly fallback?: VoiceEngine;
  private readonly finalTimeoutMs: number;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly recorderFactory: RecorderFactory;
  private readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  private readonly urlProvider?: () => Promise<string>;
  private readonly authMessageProvider: () => Promise<VoiceStreamAuthMessage>;

  constructor(options: ByteDanceStreamingEngineOptions = {}) {
    this.language = options.language?.trim() || undefined;
    this.fallback = options.fallback;
    this.finalTimeoutMs = options.finalTimeoutMs ?? 8000;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.recorderFactory = options.recorderFactory ?? createPcmStreamRecorder;
    this.getUserMedia = options.getUserMedia
      ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.urlProvider = options.urlProvider;
    this.authMessageProvider = options.authMessageProvider ?? buildVoiceStreamAuthMessage;
  }

  async start(callbacks: VoiceEngineCallbacks): Promise<VoiceEngineHandle> {
    let stream: MediaStream | null = null;
    try {
      stream = await this.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      return await this.startStreaming(stream, callbacks);
    } catch (err) {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      return this.startFallback(callbacks, err);
    }
  }

  private startStreaming(
    stream: MediaStream,
    callbacks: VoiceEngineCallbacks,
  ): Promise<VoiceEngineHandle> {
    const session = new ByteDanceVoiceStreamSession({
      fallback: this.fallback,
      finalTimeoutMs: this.finalTimeoutMs,
      socketFactory: (url) => this.socketFactory(url) as unknown as VoiceStreamSocket,
      recorderFactory: (options) => this.recorderFactory(stream, options),
      urlProvider: this.urlProvider
        ?? (() => buildVoiceStreamUrl({ language: this.language })),
      authMessageProvider: this.authMessageProvider,
    });
    return session.start(callbacks);
  }

  private startFallback(
    callbacks: VoiceEngineCallbacks,
    primaryError: unknown,
  ): VoiceEngineHandle | Promise<VoiceEngineHandle> {
    if (!this.fallback) {
      callbacks.onError(primaryError);
      return { stop: () => {} };
    }
    try {
      return this.fallback.start(callbacks);
    } catch (err) {
      callbacks.onError(err);
      return { stop: () => {} };
    }
  }
}
