import type { VoiceEngine, VoiceEngineCallbacks, VoiceEngineHandle } from "./types";
import { transcribeVoiceAudio } from "./transcriptionApi";

interface GptTranscriptionEngineOptions {
  model?: string;
  language?: string;
  fallback?: VoiceEngine;
}

interface PcmRecorder {
  stop(): Promise<Blob>;
}

interface ShadowFallbackState {
  forwarding: boolean;
  handle: VoiceEngineHandle | null;
  text: string;
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

const DEFAULT_MODEL = "gpt-4o-transcribe";

export class GptTranscriptionEngine implements VoiceEngine {
  private readonly model: string;
  private readonly language?: string;
  private readonly fallback?: VoiceEngine;

  constructor(options: GptTranscriptionEngineOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.language = options.language?.trim() || "zh";
    this.fallback = options.fallback;
  }

  async start(callbacks: VoiceEngineCallbacks): Promise<VoiceEngineHandle> {
    if (!supportsAudioRecording()) {
      return this.startFallback(callbacks, new Error("Web Audio recording not supported"));
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return await this.startRecording(stream, callbacks);
    } catch (err) {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      return this.startFallback(callbacks, err);
    }
  }

  private async startRecording(
    stream: MediaStream,
    callbacks: VoiceEngineCallbacks,
  ): Promise<VoiceEngineHandle> {
    const recorder = await createPcmRecorder(stream);
    const fallback = await this.startShadowFallback(callbacks);
    let cancelled = false;
    let stopTask: Promise<void> | null = null;

    const finish = async (commit: boolean) => {
      if (stopTask) return stopTask;
      cancelled = !commit;
      stopTask = (async () => {
        const audio = await recorder.stop();
        if (cancelled) {
          await stopShadowFallback(fallback, false);
          return;
        }
        if (audio.size === 0) {
          throw new Error("No audio captured");
        }

        try {
          const text = await transcribeVoiceAudio(audio, {
            model: this.model,
            language: this.language,
          });
          fallback.forwarding = false;
          await stopShadowFallback(fallback, false);
          if (!cancelled) callbacks.onFinal(text);
        } catch (err) {
          await stopShadowFallback(fallback, true);
          const fallbackText = fallback.text.trim();
          if (fallbackText) {
            callbacks.onFinal(fallbackText);
            return;
          }
          throw err;
        }
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
      forwarding: true,
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

function supportsAudioRecording(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof window !== "undefined"
    && Boolean(getAudioContextCtor());
}

async function createPcmRecorder(stream: MediaStream): Promise<PcmRecorder> {
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) throw new Error("AudioContext API not supported");

  const audioContext = new AudioContextCtor();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    event.outputBuffer.getChannelData(0).fill(0);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return new Blob([], { type: "audio/wav" });
      stopped = true;
      processor.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await audioContext.close();
      return encodeWav(chunks, audioContext.sampleRate);
    },
  };
}

function getAudioContextCtor(): AudioContextConstructor | undefined {
  return window.AudioContext
    || (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
