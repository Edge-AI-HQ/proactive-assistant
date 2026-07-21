import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  const removedListeners: string[] = [];
  const hardware = {
    requestPermissions: vi.fn(async () => ({ bluetooth: "granted" })),
    addListener: vi.fn((eventName: string, listener: (event: unknown) => void) => {
      listeners.set(eventName, listener);
      return {
        remove() {
          removedListeners.push(eventName);
          listeners.delete(eventName);
        },
      };
    }),
    startMonitoring: vi.fn(async () => {}),
    stopMonitoring: vi.fn(async () => {}),
    stopCapture: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      supported: true,
      connected: true,
      scanning: false,
      captureRunning: false,
      status: "connected",
      timestamp: Date.now(),
    })),
    restartAsr: vi.fn(async () => {}),
  };
  return {
    hardware,
    listeners,
    removedListeners,
    mintToken: vi.fn(async () => ({ url: "wss://example.test/asr" })),
    applyTranscript: vi.fn(),
  };
});

vi.mock("../../../modules/pin-hardware", () => ({ PinHardware: mocks.hardware }));
vi.mock("../live/pin-hardware-transcript-store", () => ({
  applyPinHardwareTranscriptEvent: mocks.applyTranscript,
  pinHardwareSpeakerLabel: (speakerId?: string, speakerLabel?: string) => {
    if (speakerLabel) return speakerLabel;
    const numericId = Number(speakerId);
    if (Number.isInteger(numericId) && numericId >= 0 && numericId < 26) {
      return `Speaker ${String.fromCharCode(65 + numericId)}`;
    }
    return numericId < 0 ? "Speaker ?" : "PINAI";
  },
}));
vi.mock("@pin-ai/core", () => ({
  SIGNAL_KINDS: {
    pinHardwareState: "device.pin_hardware_state",
    pinHardwareTranscript: "device.pin_hardware_transcript",
  },
  mintPinHardwareAsrToken: mocks.mintToken,
}));

import { createPinHardwareSource } from "./pin-hardware";

describe("createPinHardwareSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.removedListeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("cleans up listeners when monitoring fails to start", async () => {
    mocks.hardware.startMonitoring.mockRejectedValueOnce(new Error("monitoring failed"));
    const source = createPinHardwareSource({ push: vi.fn(), onEvent: vi.fn() });

    await expect(source.start()).rejects.toThrow("monitoring failed");

    expect(source.isStarted()).toBe(false);
    expect(mocks.removedListeners).toEqual(["pinHardwareState", "pinHardwareTranscript"]);
    expect(mocks.hardware.stopMonitoring).toHaveBeenCalledOnce();
  });

  test("does not restart ASR after the source stops during token minting", async () => {
    let resolveToken: ((value: { url: string }) => void) | undefined;
    mocks.mintToken.mockImplementationOnce(() => new Promise((resolve) => {
      resolveToken = resolve;
    }));
    const source = createPinHardwareSource({ push: vi.fn(), onEvent: vi.fn() });
    await source.start();

    mocks.listeners.get("pinHardwareState")?.({
      supported: true,
      connected: true,
      scanning: false,
      captureRunning: true,
      status: "asr_error",
      timestamp: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.mintToken).toHaveBeenCalledOnce();

    await source.stop();
    resolveToken?.({ url: "wss://example.test/retry" });
    await Promise.resolve();

    expect(mocks.hardware.restartAsr).not.toHaveBeenCalled();
  });

  test("reuses Tencent speaker context when healing the ASR socket", async () => {
    const source = createPinHardwareSource({ push: vi.fn(), onEvent: vi.fn() });
    await source.start();
    mocks.listeners.get("pinHardwareTranscript")?.({
      text: "draft",
      isFinal: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
      speakerContextId: "context-1",
    });
    mocks.listeners.get("pinHardwareState")?.({
      supported: true,
      connected: true,
      scanning: false,
      captureRunning: true,
      status: "asr_error",
      speakerContextId: "context-1",
      timestamp: Date.now(),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.mintToken).toHaveBeenCalledWith({ speakerContextId: "context-1" });
    expect(mocks.hardware.restartAsr).toHaveBeenCalledWith({ asrUrl: "wss://example.test/asr" });
  });

  test("drops Tencent speaker context after the native context is reset", async () => {
    const source = createPinHardwareSource({ push: vi.fn(), onEvent: vi.fn() });
    await source.start();
    mocks.listeners.get("pinHardwareTranscript")?.({
      text: "draft",
      isFinal: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
      speakerContextId: "context-1",
    });
    mocks.listeners.get("pinHardwareState")?.({
      supported: true,
      connected: true,
      scanning: false,
      captureRunning: true,
      status: "connected",
      timestamp: Date.now(),
    });
    mocks.listeners.get("pinHardwareState")?.({
      supported: true,
      connected: true,
      scanning: false,
      captureRunning: true,
      status: "asr_error",
      timestamp: Date.now(),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.mintToken).toHaveBeenCalledWith({ speakerContextId: undefined });
  });

  test("backs off consecutive ASR failures and stops after three attempts", async () => {
    const onEvent = vi.fn();
    const source = createPinHardwareSource({ push: vi.fn(), onEvent });
    await source.start();
    const emitAsrError = () => mocks.listeners.get("pinHardwareState")?.({
      supported: true,
      connected: true,
      scanning: false,
      captureRunning: true,
      status: "asr_error",
      timestamp: Date.now(),
    });

    emitAsrError();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.hardware.restartAsr).toHaveBeenCalledTimes(1);

    emitAsrError();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.hardware.restartAsr).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.hardware.restartAsr).toHaveBeenCalledTimes(2);

    emitAsrError();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(mocks.hardware.restartAsr).toHaveBeenCalledTimes(3);

    emitAsrError();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.hardware.restartAsr).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenCalledWith("pin_hardware", "PIN hardware ASR stream restarted (attempt 1)");
    expect(onEvent).toHaveBeenCalledWith("pin_hardware", "PIN hardware ASR stream restarted (attempt 2)");
    expect(onEvent).toHaveBeenCalledWith("pin_hardware", "PIN hardware ASR stream restarted (attempt 3)");
  });

  test("updates the shared transcript store for interim and final events", async () => {
    const push = vi.fn();
    const source = createPinHardwareSource({ push, onEvent: vi.fn() });
    await source.start();
    push.mockClear();
    const interim = {
      text: "hello",
      isFinal: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
      provider: "tencent",
      deviceId: "mr20",
      voiceId: "voice-1",
      sliceIndex: 0,
    };

    mocks.listeners.get("pinHardwareTranscript")?.(interim);

    expect(mocks.applyTranscript).toHaveBeenCalledWith(interim);
    expect(push).not.toHaveBeenCalled();

    const final = { ...interim, text: "hello world", isFinal: true };
    mocks.listeners.get("pinHardwareTranscript")?.(final);

    expect(mocks.applyTranscript).toHaveBeenLastCalledWith(final);
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0]?.[0]).toMatchObject({
      summary: "hello world",
      payload: { is_final: true },
    });
  });

  test("persists each finalized speaker sentence only once across snapshots", async () => {
    const push = vi.fn();
    const source = createPinHardwareSource({ push, onEvent: vi.fn() });
    await source.start();
    push.mockClear();

    mocks.listeners.get("pinHardwareTranscript")?.({
      text: "first\nsecond draft",
      isFinal: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
      provider: "tencent_rtasr",
      deviceId: "mr20",
      voiceId: "voice-1",
      segments: [
        { sentenceId: 0, speakerId: "0", text: "first", isFinal: true },
        { sentenceId: 1, speakerId: "-1", text: "second draft", isFinal: false },
      ],
    });
    mocks.listeners.get("pinHardwareTranscript")?.({
      text: "first\nsecond finalized",
      isFinal: true,
      capturedAt: "2026-07-17T10:00:02.000Z",
      provider: "tencent_rtasr",
      deviceId: "mr20",
      voiceId: "voice-1",
      segments: [
        { sentenceId: 0, speakerId: "0", text: "first", isFinal: true },
        { sentenceId: 1, speakerId: "1", text: "second finalized", isFinal: true },
      ],
    });

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0]?.[0]).toMatchObject({
      summary: "first",
      payload: { speaker_segments: [{ speaker: "Speaker A", text: "first" }] },
    });
    expect(push.mock.calls[1]?.[0]).toMatchObject({
      summary: "second finalized",
      payload: { speaker_segments: [{ speaker: "Speaker B", text: "second finalized" }] },
    });
  });
});
