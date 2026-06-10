import { describe, expect, test, vi } from "vitest";

import { ByteDanceStreamingEngine } from "./ByteDanceStreamingEngine";
import type { PcmStreamRecorder } from "./pcm-recorder";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;

  readyState = FakeSocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

describe("ByteDanceStreamingEngine", () => {
  test("buffers mic chunks until websocket opens and forwards live transcript events", async () => {
    const sockets: FakeSocket[] = [];
    const stopRecorder = vi.fn();
    const recorderFactory = vi.fn(
      async (
        _stream: MediaStream,
        options: { onChunk(chunk: ArrayBuffer): void; chunkDurationMs?: number; sampleRate?: number },
      ) => {
        options.onChunk(new Uint8Array([1, 2, 3]).buffer);
        return { stop: stopRecorder } satisfies PcmStreamRecorder;
      },
    );
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    const partial = vi.fn();
    const final = vi.fn();
    const ready = vi.fn();

    const engine = new ByteDanceStreamingEngine({
      language: "zh",
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      recorderFactory,
      getUserMedia,
      urlProvider: async () => "wss://api.example.test/api/voice/transcribe-stream?language=zh",
      authMessageProvider: async () => ({ type: "auth", token: "token-a" }),
    });

    const handle = await engine.start({
      onPartial: partial,
      onFinal: final,
      onError: vi.fn(),
      onReady: ready,
    });

    expect(recorderFactory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chunkDurationMs: 100, sampleRate: 16_000 }),
    );
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual([]);
    expect(ready).not.toHaveBeenCalled();

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

  test("surfaces upstream configuration errors when fallback is disabled", async () => {
    const sockets: FakeSocket[] = [];
    const recorderFactory = vi.fn(async () => ({ stop: vi.fn() }) satisfies PcmStreamRecorder);
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    const error = vi.fn();
    const engine = new ByteDanceStreamingEngine({
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      recorderFactory,
      getUserMedia,
      urlProvider: async () => "wss://api.example.test/api/voice/transcribe-stream?language=zh",
      authMessageProvider: async () => ({ type: "auth", token: "token-a" }),
    });

    await engine.start({
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: error,
    });

    sockets[0].open();
    sockets[0].message({
      type: "error",
      message: "ByteDance streaming ASR is not configured",
    });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ByteDance streaming ASR is not configured",
      }),
    );
  });

  test("cleans recorder and shadow fallback when streaming setup fails", async () => {
    const recorderStop = vi.fn();
    const fallbackStop = vi.fn();
    const fallbackStart = vi.fn(() => ({ stop: fallbackStop, cancel: fallbackStop }));
    const getUserMedia = vi.fn(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    const engine = new ByteDanceStreamingEngine({
      recorderFactory: async () => ({ stop: recorderStop }) satisfies PcmStreamRecorder,
      getUserMedia,
      fallback: { start: fallbackStart },
      urlProvider: async () => {
        throw new Error("missing session");
      },
    });

    const handle = await engine.start({
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
    });

    expect(recorderStop).toHaveBeenCalledTimes(1);
    expect(fallbackStop).toHaveBeenCalledTimes(1);
    expect(fallbackStart).toHaveBeenCalledTimes(2);

    await handle.stop();
    expect(fallbackStop).toHaveBeenCalledTimes(2);
  });
});
