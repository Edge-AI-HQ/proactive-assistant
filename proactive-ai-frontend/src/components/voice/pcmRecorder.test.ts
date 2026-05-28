import { describe, expect, test } from "vitest";

describe("encodeWav", () => {
  test("writes a mono PCM WAV blob", async () => {
    const { encodeWavForTest } = await import("./pcmRecorder");
    const blob = encodeWavForTest([new Float32Array([0, 0.5, -0.5])], 16_000);
    const bytes = new Uint8Array(await readBlob(blob));

    expect(blob.type).toBe("audio/wav");
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
  });
});

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}
