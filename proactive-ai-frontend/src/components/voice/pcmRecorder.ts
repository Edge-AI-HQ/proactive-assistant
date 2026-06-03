export interface PcmRecorder {
  stop(): Promise<Blob>;
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

export function encodeWavForTest(chunks: Float32Array[], sampleRate: number): Blob {
  return encodeWav(chunks, sampleRate);
}
