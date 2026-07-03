import { describe, expect, test, vi } from "vitest";

import {
  ByteDanceVoiceStreamSession,
  type VoicePcmStreamRecorder,
  type VoiceStreamSocket,
} from "./voice-stream";

class FakeSocket implements VoiceStreamSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("ByteDanceVoiceStreamSession", () => {
  test("buffers PCM chunks until the websocket opens and forwards transcript events", async () => {
    const sockets: FakeSocket[] = [];
    const stopRecorder = vi.fn();
    const recorderFactory = vi.fn(
      async (options: { onChunk(chunk: ArrayBuffer): void }) => {
        options.onChunk(new Uint8Array([1, 2, 3]).buffer);
        return { stop: stopRecorder } satisfies VoicePcmStreamRecorder;
      },
    );
    const partial = vi.fn();
    const final = vi.fn();
    const ready = vi.fn();

    const session = new ByteDanceVoiceStreamSession({
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      recorderFactory,
      urlProvider: async () => "wss://api.example.test/api/voice/transcribe-stream?language=zh",
      authMessageProvider: async () => ({ type: "auth", token: "token-a" }),
    });

    const handle = await session.start({
      onPartial: partial,
      onFinal: final,
      onError: vi.fn(),
      onReady: ready,
    });

    expect(recorderFactory).toHaveBeenCalledWith(
      expect.objectContaining({ chunkDurationMs: 100, sampleRate: 16_000 }),
    );
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual([]);

    sockets[0].open();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sockets[0].sent[0] as string)).toEqual({ type: "auth", token: "token-a" });
    expect(sockets[0].sent[1]).toEqual(new Uint8Array([1, 2, 3]).buffer);

    sockets[0].message({ type: "partial", text: "今天 review" });
    sockets[0].message({ type: "final", text: "今天 review Codex patch。" });

    expect(partial).toHaveBeenCalledWith("今天 review");
    expect(final).toHaveBeenCalledWith("今天 review Codex patch。");

    await handle.stop();
    expect(stopRecorder).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sockets[0].sent.at(-1) as string)).toEqual({ type: "end" });
  });
});
