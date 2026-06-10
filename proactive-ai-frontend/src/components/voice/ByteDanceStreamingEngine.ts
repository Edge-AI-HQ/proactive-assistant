import type { VoiceEngine, VoiceEngineCallbacks, VoiceEngineHandle } from "./types";
import { createPcmStreamRecorder, type PcmStreamRecorder } from "./pcm-recorder";
import {
  buildVoiceStreamAuthMessage,
  buildVoiceStreamUrl,
  type VoiceStreamAuthMessage,
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

interface ShadowFallbackState {
  forwarding: boolean;
  handle: VoiceEngineHandle | null;
  text: string;
}

type RecorderFactory = NonNullable<ByteDanceStreamingEngineOptions["recorderFactory"]>;

const OPEN_READY_STATE = 1;

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

  private async startStreaming(
    stream: MediaStream,
    callbacks: VoiceEngineCallbacks,
  ): Promise<VoiceEngineHandle> {
    const pendingChunks: ArrayBuffer[] = [];
    let socket: WebSocket | null = null;
    let recorder: PcmStreamRecorder | null = null;
    let stopTask: Promise<void> | null = null;
    let cancelled = false;
    let ended = false;
    let primaryFailed = false;
    let primarySeen = false;
    let resolveFinal: () => void = () => {};
    const finalResult = new Promise<void>((resolve) => {
      resolveFinal = resolve;
    });

    let fallback: ShadowFallbackState | null = null;
    try {
      fallback = await this.startShadowFallback(callbacks);

      const sendChunk = (chunk: ArrayBuffer) => {
        if (cancelled || ended) return;
        if (socket?.readyState === OPEN_READY_STATE) {
          socket.send(chunk);
          return;
        }
        pendingChunks.push(chunk);
      };

      recorder = await this.recorderFactory(stream, {
        sampleRate: 16_000,
        chunkDurationMs: 100,
        onChunk: sendChunk,
      });

      const url = this.urlProvider
        ? await this.urlProvider()
        : await buildVoiceStreamUrl({ language: this.language });
      const authMessage = await this.authMessageProvider();
      socket = this.socketFactory(url);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        socket?.send(JSON.stringify(authMessage));
        callbacks.onReady?.();
        while (pendingChunks.length > 0 && socket?.readyState === OPEN_READY_STATE) {
          socket.send(pendingChunks.shift() as ArrayBuffer);
        }
        if (ended && socket?.readyState === OPEN_READY_STATE) {
          socket.send(JSON.stringify({ type: "end" }));
        }
      };
      socket.onmessage = (event) => {
        const payload = parseServerEvent(event.data);
        if (!payload) return;
        if (payload.type === "error") {
          primaryFailed = true;
          resolveFinal();
          if (fallback?.handle) {
            fallback.forwarding = true;
            if (fallback.text) callbacks.onPartial(fallback.text);
          } else {
            callbacks.onError(new Error(payload.message || "voice stream failed"));
          }
          return;
        }
        if ((payload.type === "partial" || payload.type === "final") && payload.text) {
          primarySeen = true;
          if (fallback) {
            fallback.forwarding = false;
            void stopShadowFallback(fallback, false);
          }
          if (payload.type === "final") {
            callbacks.onFinal(payload.text);
            resolveFinal();
          } else {
            callbacks.onPartial(payload.text);
          }
        }
      };
      socket.onerror = (event) => {
        primaryFailed = true;
        resolveFinal();
        if (fallback?.handle) {
          fallback.forwarding = true;
          if (fallback.text) callbacks.onPartial(fallback.text);
        } else {
          callbacks.onError(event);
        }
      };
      socket.onclose = () => {
        if (!primarySeen) primaryFailed = true;
        resolveFinal();
      };

      const finish = async (commit: boolean) => {
        if (stopTask) return stopTask;
        cancelled = !commit;
        stopTask = (async () => {
          if (primaryFailed && fallback?.handle) {
            await recorder?.stop();
            await stopShadowFallback(fallback, commit);
            return;
          }

          await recorder?.stop();
          if (!commit) {
            if (fallback) await stopShadowFallback(fallback, false);
            socket?.close();
            return;
          }

          ended = true;
          if (socket?.readyState === OPEN_READY_STATE) {
            socket.send(JSON.stringify({ type: "end" }));
          }
          await Promise.race([finalResult, delay(this.finalTimeoutMs)]);
          if (fallback) await stopShadowFallback(fallback, false);
          socket?.close();
        })().catch((err) => {
          if (!cancelled) callbacks.onError(err);
          throw err;
        });
        return stopTask;
      };

      return {
        stop: () => finish(true),
        cancel: () => finish(false),
      };
    } catch (err) {
      await cleanupPartiallyStartedStream(recorder, socket, fallback);
      throw err;
    }
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

  private async startShadowFallback(
    callbacks: VoiceEngineCallbacks,
  ): Promise<ShadowFallbackState> {
    const state: ShadowFallbackState = {
      forwarding: false,
      handle: null,
      text: "",
    };
    if (!this.fallback) return state;

    const update = (text: string, final: boolean) => {
      state.text = text;
      if (!state.forwarding) return;
      if (final) callbacks.onFinal(text);
      else callbacks.onPartial(text);
    };

    try {
      const handle = this.fallback.start({
        onPartial: (text) => update(text, false),
        onFinal: (text) => update(text, true),
        onError: () => {},
      });
      state.handle = handle instanceof Promise ? await handle : handle;
    } catch {
      state.handle = null;
    }
    return state;
  }
}

async function cleanupPartiallyStartedStream(
  recorder: PcmStreamRecorder | null,
  socket: WebSocket | null,
  fallback: ShadowFallbackState | null,
): Promise<void> {
  try {
    await recorder?.stop();
  } catch {
    // Best effort during setup failure.
  }
  try {
    socket?.close();
  } catch {
    // Best effort during setup failure.
  }
  if (fallback) await stopShadowFallback(fallback, false);
}

async function stopShadowFallback(
  fallback: ShadowFallbackState,
  commit: boolean,
): Promise<void> {
  const handle = fallback.handle;
  if (!handle) return;
  try {
    if (commit) await handle.stop();
    else await (handle.cancel ? handle.cancel() : handle.stop());
  } catch {
    // Browser fallback is best-effort.
  }
}

function parseServerEvent(data: unknown): { type?: string; text?: string; message?: string } | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      type: typeof record.type === "string" ? record.type : undefined,
      text: typeof record.text === "string" ? record.text : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
