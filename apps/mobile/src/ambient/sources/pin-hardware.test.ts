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
  };
});

vi.mock("../../../modules/pin-hardware", () => ({ PinHardware: mocks.hardware }));
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
});
