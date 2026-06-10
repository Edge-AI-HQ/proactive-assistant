export interface PcmRecorder {
  stop(): Promise<Blob>;
}

export interface PcmStreamRecorder {
  stop(): Promise<void>;
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

export async function createPcmRecorder(
  stream: MediaStream,
  options?: { sampleRate?: number },
): Promise<PcmRecorder> {
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) throw new Error("AudioContext API not supported");

  const audioContext = createAudioContext(AudioContextCtor, options?.sampleRate);
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

export async function createPcmStreamRecorder(
  stream: MediaStream,
  options: {
    onChunk(chunk: ArrayBuffer): void;
    sampleRate?: number;
    chunkDurationMs?: number;
  },
): Promise<PcmStreamRecorder> {
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) throw new Error("AudioContext API not supported");

  const targetSampleRate = options.sampleRate ?? 16_000;
  const chunkBytes = Math.max(
    2,
    Math.floor(targetSampleRate * 2 * ((options.chunkDurationMs ?? 200) / 1000)),
  );
  const audioContext = createAudioContext(AudioContextCtor, targetSampleRate);
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  const flushCompleteChunks = () => {
    while (pending.byteLength >= chunkBytes) {
      const chunk = pending.slice(0, chunkBytes);
      pending = pending.slice(chunkBytes);
      options.onChunk(arrayBufferFromUint8(chunk));
    }
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resampleLinear(input, audioContext.sampleRate, targetSampleRate);
    pending = concatUint8(pending, floatTo16BitPcm(resampled));
    flushCompleteChunks();
    event.outputBuffer.getChannelData(0).fill(0);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      processor.disconnect();
      source.disconnect();
      if (pending.byteLength > 0) {
        options.onChunk(arrayBufferFromUint8(pending));
        pending = new Uint8Array(0);
      }
      for (const track of stream.getTracks()) track.stop();
      await audioContext.close();
    },
  };
}

function getAudioContextCtor(): AudioContextConstructor | undefined {
  return window.AudioContext
    || (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

/**
 * Create an AudioContext, optionally pinned to a target sample rate. A forced
 * rate downsamples the mic input (e.g. 16 kHz for speech), which shrinks the
 * WAV and keeps it under downstream size limits (the diarize reference must
 * stay under the transcription API's per-part base64 cap). Some engines reject
 * a forced rate, so fall back to the device default rather than failing capture.
 */
function createAudioContext(Ctor: AudioContextConstructor, sampleRate?: number): AudioContext {
  if (sampleRate) {
    try {
      return new Ctor({ sampleRate });
    } catch {
      // fall through to the device default
    }
  }
  return new Ctor();
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

function resampleLinear(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (inputSampleRate === outputSampleRate) return new Float32Array(input);
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const weight = position - leftIndex;
    output[i] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
  }
  return output;
}

function floatTo16BitPcm(input: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function concatUint8(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return right;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

function arrayBufferFromUint8(bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function encodeWavForTest(chunks: Float32Array[], sampleRate: number): Blob {
  return encodeWav(chunks, sampleRate);
}

export function resampleLinearForTest(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  return resampleLinear(input, inputSampleRate, outputSampleRate);
}
