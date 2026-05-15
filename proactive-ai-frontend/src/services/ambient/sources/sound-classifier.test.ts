import { beforeEach, describe, expect, test, vi } from "vitest";

import { SoundClassifierSource } from "./sound-classifier";
import type { SourceContext } from "./types";

const ambientAiMock = vi.hoisted(() => {
  const listenerRemove = vi.fn(async () => {});
  return {
    listenerRemove,
    addListener: vi.fn(async () => ({ remove: listenerRemove })),
    audio: {
      getState: vi.fn(),
      startCapture: vi.fn(async () => {}),
      stopCapture: vi.fn(async () => {}),
    },
    sound: {
      requestPermissions: vi.fn(async () => ({ microphone: "granted" })),
      startClassification: vi.fn(async () => {}),
      stopClassification: vi.fn(async () => {}),
    },
  };
});

vi.mock("@pin/capacitor-ambient-ai", () => ({
  AmbientAi: ambientAiMock,
}));

describe("SoundClassifierSource transcript ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ambientAiMock.audio.getState.mockResolvedValue({
      running: true,
      paused: false,
      capturing: false,
      suppressed: false,
      classificationRunning: true,
      engineRunning: true,
    });
  });

  test("pushes transcriptReady as a session_summary signal", () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    source.handleTranscriptReadyForTest({
      platform: "ios",
      wavId: "wav-1",
      burstId: "burst-1",
      captureSessionId: "capture-1",
      text: "This is a meaningful ambient transcript worth storing.",
      capturedAt: "2026-05-10T12:00:00.000Z",
      durationMs: 2500,
      provider: "cloud_whisper",
      fallback: false,
      localProvider: "sfspeech",
      segmentIndex: 2,
      triggerSource: "audio_vad_fallback",
    });

    expect(pushed).toEqual([
      {
        kind: "session_summary",
        title: "Voice summary",
        summary: "This is a meaningful ambient transcript worth storing.",
        occurred_at: "2026-05-10T12:00:00.000Z",
        payload: {
          platform: "ios",
          wavId: "wav-1",
          burstId: "burst-1",
          captureSessionId: "capture-1",
          durationMs: 2500,
          provider: "cloud_whisper",
          fallback: false,
          localProvider: "sfspeech",
          segmentIndex: 2,
          triggerSource: "audio_vad_fallback",
        },
        salience: 0.7,
        confidence: 0.75,
        dedupe_key: "ios:audio:burst-1",
      },
    ]);
    expect(ctx.onEvent).toHaveBeenCalledWith("sound_classifier", "Voice transcript: This is a meaningful ambient transcript worth storing.");
  });

  test("ignores short transcriptReady text", () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    source.handleTranscriptReadyForTest({
      platform: "ios",
      wavId: "wav-2",
      burstId: "burst-2",
      captureSessionId: "capture-2",
      text: "too short",
      capturedAt: "2026-05-10T12:00:00.000Z",
      durationMs: 500,
      provider: "local_speech",
      fallback: true,
    });

    expect(pushed).toEqual([]);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });
  test("does not upload speech classification ticks", () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    source.handleSoundClassificationForTest({
      classifications: [{ label: "speech", confidence: 0.91 }],
      timestamp: 1_777_000_000_000,
    });

    expect(pushed).toEqual([]);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  test("aggregates non-speech classification ticks before pushing", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    source.handleSoundClassificationForTest({
      classifications: [{ label: "music", confidence: 0.81 }],
      timestamp: 1_777_000_000_000,
    });
    source.handleSoundClassificationForTest({
      classifications: [{ label: "music", confidence: 0.79 }],
      timestamp: 1_777_000_008_000,
    });
    source.handleSoundClassificationForTest({
      classifications: [{ label: "music", confidence: 0.77 }],
      timestamp: 1_777_000_016_000,
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "device.sound_scene_run",
      title: "music",
      dedupe_key: "sound:music:2026-04-24T03:06:40.000Z",
      payload: {
        schema_version: "sound_scene_run.v1",
        label: "music",
        sampleCount: 3,
      },
    });
  });

  test("cleans up listeners when native start fails", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    ambientAiMock.audio.startCapture.mockRejectedValueOnce(new Error("engine failed"));

    await expect(source.start()).rejects.toThrow("engine failed");

    expect(ambientAiMock.listenerRemove).toHaveBeenCalledTimes(2);
    expect(ambientAiMock.sound.stopClassification).toHaveBeenCalledTimes(1);
    expect(ambientAiMock.audio.stopCapture).toHaveBeenCalledTimes(1);
    expect(source.isStarted()).toBe(false);
  });

  test("refresh skips native restart while capture and classification are healthy", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    await source.start();
    vi.clearAllMocks();

    await source.refresh();

    expect(ambientAiMock.audio.getState).toHaveBeenCalled();
    expect(ambientAiMock.audio.startCapture).not.toHaveBeenCalled();
    expect(ambientAiMock.sound.startClassification).not.toHaveBeenCalled();
  });

  test("refresh does not restart while native audio is intentionally media-suppressed", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    await source.start();
    vi.clearAllMocks();
    ambientAiMock.audio.getState.mockResolvedValueOnce({
      running: true,
      paused: false,
      capturing: false,
      suppressed: true,
      suppressedReason: "media",
      classificationRunning: true,
      engineRunning: false,
    });

    await source.refresh();

    expect(ambientAiMock.audio.startCapture).not.toHaveBeenCalled();
    expect(ambientAiMock.sound.startClassification).not.toHaveBeenCalled();
  });

  test("refresh reports an error when the native sound engine stays stopped", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    await source.start();
    vi.clearAllMocks();
    ambientAiMock.audio.getState
      .mockResolvedValueOnce({
        running: true,
        paused: false,
        capturing: false,
        suppressed: false,
        classificationRunning: true,
        engineRunning: false,
      })
      .mockResolvedValueOnce({
        running: true,
        paused: false,
        capturing: false,
        suppressed: false,
        classificationRunning: true,
        engineRunning: false,
      });

    await expect(source.refresh()).rejects.toThrow("sound classifier engine not running");
  });

  test("refresh reports an error when native state stays failed despite engineRunning true", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    await source.start();
    vi.clearAllMocks();
    ambientAiMock.audio.getState
      .mockResolvedValueOnce({
        running: true,
        paused: false,
        capturing: false,
        suppressed: false,
        classificationRunning: true,
        engineRunning: true,
        engineState: "failed",
      })
      .mockResolvedValueOnce({
        running: true,
        paused: false,
        capturing: false,
        suppressed: false,
        classificationRunning: true,
        engineRunning: true,
        engineState: "failed",
      });

    await expect(source.refresh()).rejects.toThrow("sound classifier engine failed");
  });

  test("refresh reports an error when classifications stay stale despite engineRunning true", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    await source.start();
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_777_000_030_000);
    ambientAiMock.audio.getState
      .mockResolvedValueOnce({
        running: true,
        paused: false,
        capturing: false,
        suppressed: false,
        classificationRunning: true,
        engineRunning: true,
        engineState: "healthy",
        lastClassificationAt: 1_777_000_000_000,
      })
      .mockResolvedValueOnce({
        running: true,
        paused: false,
        capturing: false,
        suppressed: false,
        classificationRunning: true,
        engineRunning: true,
        engineState: "healthy",
        lastClassificationAt: 1_777_000_000_000,
      });

    await expect(source.refresh()).rejects.toThrow("sound classifier classifications stale");
  });
});
