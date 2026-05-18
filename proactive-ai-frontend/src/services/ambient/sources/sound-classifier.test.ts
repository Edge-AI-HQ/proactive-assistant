import { beforeEach, describe, expect, test, vi } from "vitest";

import { SoundClassifierSource } from "./sound-classifier";
import type { SourceContext } from "./types";
import {
  getAmbientLiveTranscriptSnapshot,
  resetAmbientLiveTranscriptForTest,
} from "../live-transcript-store";

const captureTranscriptionMock = vi.hoisted(() => ({
  transcribeAmbientCapture: vi.fn(),
}));

const ambientAiMock = vi.hoisted(() => {
  const listenerRemove = vi.fn(async () => {});
  return {
    listenerRemove,
    addListener: vi.fn(async () => ({ remove: listenerRemove })),
    audio: {
      configure: vi.fn(async () => {}),
      drainPendingTranscripts: vi.fn(async (): Promise<unknown[]> => []),
      getState: vi.fn(),
      listRecentCaptures: vi.fn(async (): Promise<{ captures: unknown[] }> => ({ captures: [] })),
      markCaptureProcessed: vi.fn(async () => {}),
      readCapture: vi.fn(),
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

vi.mock("../capture-transcription", () => captureTranscriptionMock);

async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe("SoundClassifierSource transcript ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAmbientLiveTranscriptForTest();
    captureTranscriptionMock.transcribeAmbientCapture.mockReset();
    ambientAiMock.audio.drainPendingTranscripts.mockResolvedValue([]);
    ambientAiMock.audio.listRecentCaptures.mockResolvedValue({ captures: [] });
    ambientAiMock.audio.markCaptureProcessed.mockResolvedValue(undefined);
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
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-1" });
  });

  test("transcribes captureReady through the backend proxy and pushes the session summary", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "我现在说话应该尽快显示出来，并且进入 ambient transcript session summary。",
      event: {},
    });

    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-cloud",
      burstId: "burst-cloud",
      captureSessionId: "capture-cloud",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
      triggerSource: "sound_analysis",
    });

    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({ wavId: "wav-cloud" }),
      "zh",
    );
    expect(getAmbientLiveTranscriptSnapshot()).toMatchObject({
      captureSessionId: "capture-cloud",
      messages: [
        {
          id: "burst-cloud",
          text: "我现在说话应该尽快显示出来，并且进入 ambient transcript session summary。",
          source: "cloud_whisper",
        },
      ],
    });
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        title: "Voice summary",
        summary: "我现在说话应该尽快显示出来，并且进入 ambient transcript session summary。",
        occurred_at: "2026-05-17T05:15:12.000Z",
        payload: expect.objectContaining({
          platform: "ios",
          wavId: "wav-cloud",
          burstId: "burst-cloud",
          captureSessionId: "capture-cloud",
          durationMs: 3500,
          provider: "cloud_whisper",
          fallback: false,
          triggerSource: "sound_analysis",
        }),
        dedupe_key: "ios:audio:burst-cloud",
      }),
    ]);
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-cloud" });
  });

  test("marks empty cloud transcription captures as processed without storing a signal", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "   ",
      event: {},
    });

    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-empty",
      burstId: "burst-empty",
      captureSessionId: "capture-empty",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
    });

    expect(pushed).toEqual([]);
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-empty" });
  });

  test("uses user language preference for native recognition and cloud transcription", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
      getTranscriptionLanguage: () => "en-US",
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "English ambient transcript should use the user preference.",
      event: {},
    });

    await source.start();
    await source.flushPendingAudioRecoveryForTest();
    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-en",
      burstId: "burst-en",
      captureSessionId: "capture-en",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
    });

    expect(ambientAiMock.audio.configure).toHaveBeenCalledWith(expect.objectContaining({
      recognitionLocale: "en-US",
    }));
    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({ wavId: "wav-en" }),
      "en",
    );
  });

  test("starts live capture before recovering persisted captures", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    ambientAiMock.audio.listRecentCaptures.mockResolvedValue({
      captures: [
        {
          wavId: "wav-persisted",
          burstId: "burst-persisted",
          captureSessionId: "capture-persisted",
          capturedAt: "2026-05-18T02:46:30.000Z",
          durationMs: 3080,
          byteSize: 295_616,
        },
      ],
    });
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "Persisted capture should be recovered after live capture is already running.",
      event: {},
    });

    await source.start();
    await source.flushPendingAudioRecoveryForTest();

    const startCaptureOrder = ambientAiMock.audio.startCapture.mock.invocationCallOrder[0];
    const transcribeOrder = captureTranscriptionMock.transcribeAmbientCapture.mock.invocationCallOrder[0];
    expect(startCaptureOrder).toBeLessThan(transcribeOrder);
  });

  test("does not duplicate session summary when native transcriptReady follows captureReady", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "Backend transcript is stored once even if native speech emits later.",
      event: {},
    });

    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-dup",
      burstId: "burst-dup",
      captureSessionId: "capture-dup",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
    });
    source.handleTranscriptReadyForTest({
      platform: "ios",
      wavId: "wav-dup",
      burstId: "burst-dup",
      captureSessionId: "capture-dup",
      text: "Native transcript should not create a duplicate row for the same speech burst.",
      capturedAt: "2026-05-17T05:15:20.000Z",
      durationMs: 3500,
      provider: "local_speech",
      fallback: false,
    });

    expect(pushed).toHaveLength(1);
  });

  test("does not delete a capture while its cloud transcription is still reading it", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    let resolveTranscription: ((value: { text: string; event: Record<string, never> }) => void) | undefined;
    captureTranscriptionMock.transcribeAmbientCapture.mockReturnValue(new Promise((resolve) => {
      resolveTranscription = resolve;
    }));

    const inFlight = source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-race",
      burstId: "burst-race",
      captureSessionId: "capture-race",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
    });
    source.handleTranscriptReadyForTest({
      platform: "ios",
      wavId: "wav-race",
      burstId: "burst-race",
      captureSessionId: "capture-race",
      text: "Native transcript may arrive while cloud transcription is still reading the WAV.",
      capturedAt: "2026-05-17T05:15:20.000Z",
      durationMs: 3500,
      provider: "local_speech",
      fallback: false,
    });

    expect(ambientAiMock.audio.markCaptureProcessed).not.toHaveBeenCalled();

    resolveTranscription?.({
      text: "Cloud transcript should not create a duplicate signal after native text was stored.",
      event: {},
    });
    await inFlight;

    expect(pushed).toHaveLength(1);
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-race" });
  });

  test("does not push or delete recovered captures after the source stops", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    let resolveTranscription: ((value: { text: string; event: Record<string, never> }) => void) | undefined;
    captureTranscriptionMock.transcribeAmbientCapture.mockReturnValue(new Promise((resolve) => {
      resolveTranscription = resolve;
    }));

    await source.start();
    await source.flushPendingAudioRecoveryForTest();
    ambientAiMock.audio.listRecentCaptures.mockResolvedValueOnce({
      captures: [
        {
          wavId: "wav-stop",
          burstId: "burst-stop",
          captureSessionId: "capture-stop",
          capturedAt: "2026-05-18T02:46:30.000Z",
          durationMs: 3080,
          byteSize: 295_616,
        },
      ],
    });

    await source.refresh();
    await flushMicrotasks();
    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({ wavId: "wav-stop" }),
      "zh",
    );

    await source.stop();
    resolveTranscription?.({
      text: "This transcript finished after the source stopped and should be ignored.",
      event: {},
    });
    await source.flushPendingAudioRecoveryForTest();

    expect(pushed).toEqual([]);
    expect(ambientAiMock.audio.markCaptureProcessed).not.toHaveBeenCalledWith({ wavId: "wav-stop" });
  });

  test("runs a queued recovery scan when refresh happens during pending recovery", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    let resolveFirstTranscription: ((value: { text: string; event: Record<string, never> }) => void) | undefined;
    captureTranscriptionMock.transcribeAmbientCapture
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirstTranscription = resolve;
      }))
      .mockResolvedValueOnce({
        text: "Second queued recovery transcript should be picked up automatically.",
        event: {},
      });

    await source.start();
    await source.flushPendingAudioRecoveryForTest();
    ambientAiMock.audio.listRecentCaptures.mockResolvedValueOnce({
      captures: [
        {
          wavId: "wav-first",
          burstId: "burst-first",
          captureSessionId: "capture-first",
          capturedAt: "2026-05-18T02:46:30.000Z",
          durationMs: 3080,
          byteSize: 295_616,
        },
      ],
    });

    await source.refresh();
    await flushMicrotasks();
    ambientAiMock.audio.listRecentCaptures.mockResolvedValueOnce({
      captures: [
        {
          wavId: "wav-second",
          burstId: "burst-second",
          captureSessionId: "capture-second",
          capturedAt: "2026-05-18T02:46:45.000Z",
          durationMs: 3080,
          byteSize: 295_616,
        },
      ],
    });
    await source.refresh();

    resolveFirstTranscription?.({
      text: "First recovery transcript should complete before the queued scan.",
      event: {},
    });
    await source.flushPendingAudioRecoveryForTest();

    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({ wavId: "wav-first" }),
      "zh",
    );
    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({ wavId: "wav-second" }),
      "zh",
    );
    expect(pushed).toEqual([
      expect.objectContaining({ dedupe_key: "ios:audio:burst-first" }),
      expect.objectContaining({ dedupe_key: "ios:audio:burst-second" }),
    ]);
  });

  test("drains pending native transcripts on refresh after background", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    await source.start();
    await source.flushPendingAudioRecoveryForTest();
    ambientAiMock.audio.drainPendingTranscripts.mockResolvedValueOnce([
      {
        platform: "ios",
        wavId: "wav-background",
        burstId: "burst-background",
        captureSessionId: "capture-background",
        text: "Background transcript should be recovered when the app returns foreground.",
        capturedAt: "2026-05-18T02:40:00.000Z",
        durationMs: 6200,
        provider: "local_speech",
        fallback: false,
        localProvider: "sfspeech",
        segmentIndex: 8,
        triggerSource: "audio_vad_fallback",
      },
    ]);

    await source.refresh();
    await source.flushPendingAudioRecoveryForTest();

    expect(ambientAiMock.audio.drainPendingTranscripts).toHaveBeenCalledTimes(2);
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        summary: "Background transcript should be recovered when the app returns foreground.",
        dedupe_key: "ios:audio:burst-background",
      }),
    ]);
  });

  test("transcribes missed recent captures on refresh after background", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "Recovered cloud transcript from a background audio capture.",
      event: {},
    });

    await source.start();
    await source.flushPendingAudioRecoveryForTest();
    ambientAiMock.audio.listRecentCaptures.mockResolvedValueOnce({
      captures: [
        {
          wavId: "wav-missed",
          burstId: "burst-missed",
          captureSessionId: "capture-missed",
          capturedAt: "2026-05-18T02:46:30.000Z",
          durationMs: 3080,
          byteSize: 295_616,
        },
      ],
    });

    await source.refresh();
    await source.flushPendingAudioRecoveryForTest();

    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        wavId: "wav-missed",
        burstId: "burst-missed",
        triggerSource: "recent_capture_scan",
      }),
      "zh",
    );
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        summary: "Recovered cloud transcript from a background audio capture.",
        dedupe_key: "ios:audio:burst-missed",
      }),
    ]);
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

    expect(ambientAiMock.audio.configure).toHaveBeenCalledWith({
      recognitionLocale: "zh-CN",
      postRollMs: 2500,
      maxBurstMs: 12000,
      minBurstMs: 600,
    });
    expect(ambientAiMock.listenerRemove).toHaveBeenCalledTimes(3);
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
