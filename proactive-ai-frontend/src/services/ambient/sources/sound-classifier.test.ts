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
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  let failListenerEventName: string | null = null;
  return {
    listenerRemove,
    listeners,
    setFailListenerEventName: (eventName: string | null) => {
      failListenerEventName = eventName;
    },
    addListener: vi.fn(async (eventName: string, listener: (event: unknown) => void) => {
      if (eventName === failListenerEventName) {
        throw new Error(`listener failed: ${eventName}`);
      }
      listeners[eventName] ??= [];
      listeners[eventName].push(listener);
      return { remove: listenerRemove };
    }),
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
    for (const key of Object.keys(ambientAiMock.listeners)) {
      delete ambientAiMock.listeners[key];
    }
    ambientAiMock.setFailListenerEventName(null);
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

  test("shows listening immediately when native speechBurst arrives", async () => {
    vi.setSystemTime(new Date(1_777_000_001_500));
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    await source.start();
    ambientAiMock.listeners.speechBurst?.[0]?.({
      confidence: 0.5,
      durationMs: 0,
      timestamp: 1_777_000_001_000,
      triggerSource: "audio_vad_fallback",
    });

    expect(getAmbientLiveTranscriptSnapshot()?.messages).toContainEqual(
      expect.objectContaining({
        id: "listening",
        text: "Listening...",
      }),
    );
    vi.useRealTimers();
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
          speaker_segments: [],
          speaker_labels: [],
          self_text: "",
          diarization_status: "fallback_plain_text",
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
    vi.setSystemTime(new Date("2026-05-17T05:15:30.000Z"));
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "我现在说话应该尽快显示出来，并且进入 ambient transcript session summary。",
      selfText: "我现在说话应该尽快显示出来",
      speakerLabels: ["self", "speaker_1"],
      segments: [
        { speaker: "self", text: "我现在说话应该尽快显示出来", startMs: 0, endMs: 1800 },
        { speaker: "speaker_1", text: "并且进入 ambient transcript session summary。", startMs: 1800, endMs: 3500 },
      ],
      diarizationStatus: "matched_reference",
      diarizationModel: "gpt-4o-transcribe-diarize",
      provider: "cloud_diarize",
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
      undefined,
    );
    expect(getAmbientLiveTranscriptSnapshot()).toMatchObject({
      captureSessionId: "capture-cloud",
      messages: [
        {
          id: "burst-cloud",
          text: 'self: "我现在说话应该尽快显示出来"\nspeaker_1: "并且进入 ambient transcript session summary。"',
          source: "cloud_diarize",
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
          provider: "cloud_diarize",
          fallback: false,
          triggerSource: "sound_analysis",
          speaker_segments: [
            { speaker: "self", text: "我现在说话应该尽快显示出来", start_ms: 0, end_ms: 1800 },
            { speaker: "speaker_1", text: "并且进入 ambient transcript session summary。", start_ms: 1800, end_ms: 3500 },
          ],
          speaker_labels: ["self", "speaker_1"],
          self_text: "我现在说话应该尽快显示出来",
          diarization_model: "gpt-4o-transcribe-diarize",
          diarization_status: "matched_reference",
        }),
        dedupe_key: "ios:audio:burst-cloud",
      }),
    ]);
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-cloud" });
    vi.useRealTimers();
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

  test("uses user language preference for native recognition but leaves cloud transcription mixed", async () => {
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
      undefined,
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

  test("does not duplicate the signal or delete the WAV after stop, but still surfaces the late text in the live transcript", async () => {
    vi.setSystemTime(new Date("2026-05-18T02:46:45.000Z"));
    // Earlier we hard-dropped everything (signal + live UI + WAV cleanup)
    // when a transcript finished after stop(). That fed the "switching the
    // mic loses text" complaint: the user said something just before
    // stopping, transcription took a few seconds, and by the time it
    // resolved the source was no longer "active" so the text vanished.
    // New invariant: the late transcript lands in the captureSession's
    // live transcript widget (idempotent by burstId), the signal push
    // skips (would duplicate after recovery), and the WAV stays on disk
    // so the next run's recovery scan picks it up and pushes the signal.
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
      undefined,
    );

    await source.stop();
    resolveTranscription?.({
      text: "This transcript finished after the source stopped — the user should still see it in the live widget.",
      event: {},
    });
    await source.flushPendingAudioRecoveryForTest();

    expect(pushed).toEqual([]);
    expect(ambientAiMock.audio.markCaptureProcessed).not.toHaveBeenCalledWith({ wavId: "wav-stop" });
    expect(getAmbientLiveTranscriptSnapshot()).toMatchObject({
      captureSessionId: "capture-stop",
      messages: [
        {
          id: "burst-stop",
          text: "This transcript finished after the source stopped — the user should still see it in the live widget.",
        },
      ],
    });
    expect(ctx.onEvent).toHaveBeenCalledWith(
      "sound_classifier",
      "discard:runid_skip_signal burst=burst-stop",
    );
    vi.useRealTimers();
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
      undefined,
    );
    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledWith(
      expect.objectContaining({ wavId: "wav-second" }),
      undefined,
    );
    expect(pushed).toEqual([
      expect.objectContaining({ dedupe_key: "ios:audio:burst-first" }),
      expect.objectContaining({ dedupe_key: "ios:audio:burst-second" }),
    ]);
  });

  test("ignores pending local speech transcripts on refresh after background", async () => {
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
    expect(pushed).toEqual([]);
    expect(ambientAiMock.audio.markCaptureProcessed).not.toHaveBeenCalledWith({ wavId: "wav-background" });
    expect(ctx.onEvent).toHaveBeenCalledWith("sound_classifier", "Ignored transcript provider: local_speech");
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
      undefined,
    );
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        summary: "Recovered cloud transcript from a background audio capture.",
        dedupe_key: "ios:audio:burst-missed",
      }),
    ]);
  });

  test("paginates pending recent captures during recovery", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "Second page capture should be recovered.",
      event: {},
    });

    await source.start();
    await source.flushPendingAudioRecoveryForTest();
    ambientAiMock.audio.listRecentCaptures.mockClear();
    const firstPage = Array.from({ length: 25 }, (_, index) => ({
      wavId: `wav-page-1-${index}`,
      capturedAt: `2026-05-18T02:46:${String(59 - index).padStart(2, "0")}.000Z`,
      durationMs: 1000,
      byteSize: 1000,
    }));
    ambientAiMock.audio.listRecentCaptures
      .mockResolvedValueOnce({ captures: firstPage })
      .mockResolvedValueOnce({
        captures: [
          {
            wavId: "wav-page-2",
            burstId: "burst-page-2",
            captureSessionId: "capture-page-2",
            capturedAt: "2026-05-18T02:45:30.000Z",
            durationMs: 3080,
            byteSize: 295_616,
          },
        ],
      });

    await source.refresh();
    await source.flushPendingAudioRecoveryForTest();

    expect(ambientAiMock.audio.listRecentCaptures).toHaveBeenNthCalledWith(1, {
      limit: 25,
      cursor: undefined,
      order: "desc",
    });
    expect(ambientAiMock.audio.listRecentCaptures).toHaveBeenNthCalledWith(2, {
      limit: 25,
      cursor: "2026-05-18T02:46:35.000Z",
      order: "desc",
    });
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        summary: "Second page capture should be recovered.",
        dedupe_key: "ios:audio:burst-page-2",
      }),
    ]);
  });

  test("keeps failed cloud captures unprocessed so recovery can retry them", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture
      .mockRejectedValueOnce(new Error("network offline"))
      .mockResolvedValueOnce({
        text: "Recovered cloud transcript after the network came back.",
        event: {},
      });

    await source.start();
    await source.flushPendingAudioRecoveryForTest();

    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-retry",
      burstId: "burst-retry",
      captureSessionId: "capture-retry",
      capturedAt: "2026-05-18T02:46:30.000Z",
      durationMs: 3080,
      byteSize: 295_616,
    });

    expect(pushed).toEqual([]);
    expect(ambientAiMock.audio.markCaptureProcessed).not.toHaveBeenCalledWith({ wavId: "wav-retry" });
    expect(ctx.onEvent).toHaveBeenCalledWith(
      "sound_classifier",
      "Voice transcription failed: network offline",
    );

    ambientAiMock.audio.listRecentCaptures.mockResolvedValueOnce({
      captures: [
        {
          wavId: "wav-retry",
          burstId: "burst-retry",
          captureSessionId: "capture-retry",
          capturedAt: "2026-05-18T02:46:30.000Z",
          durationMs: 3080,
          byteSize: 295_616,
        },
      ],
    });

    await source.refresh();
    await source.flushPendingAudioRecoveryForTest();

    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenCalledTimes(2);
    expect(captureTranscriptionMock.transcribeAmbientCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wavId: "wav-retry",
        burstId: "burst-retry",
        triggerSource: "recent_capture_scan",
      }),
      undefined,
    );
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        summary: "Recovered cloud transcript after the network came back.",
        dedupe_key: "ios:audio:burst-retry",
      }),
    ]);
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-retry" });
  });

  test("delivers short transcriptReady text — short replies must not be silently dropped", () => {
    vi.setSystemTime(new Date("2026-05-10T12:00:30.000Z"));
    // Earlier versions filtered transcripts < 24 chars out of both the live
    // UI and the outbox. Short Chinese replies ("好的", "等一下", "什么时候
    // 开会") all sit under 24 chars and got eaten, which was a dominant
    // source of "where did my text go" complaints. The capture pipeline
    // must not eat user speech; any length-based filtering belongs
    // downstream (signal generation, summarization), not here.
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
      text: "好的",
      capturedAt: "2026-05-10T12:00:00.000Z",
      durationMs: 500,
      provider: "cloud_whisper",
      fallback: true,
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "session_summary",
      summary: "好的",
      dedupe_key: "ios:audio:burst-2",
    });
    expect(getAmbientLiveTranscriptSnapshot()).toMatchObject({
      captureSessionId: "capture-2",
      messages: [{ id: "burst-2", text: "好的", source: "cloud_whisper" }],
    });
    expect(ctx.onEvent).toHaveBeenCalledWith("sound_classifier", "Voice transcript: 好的");
    vi.useRealTimers();
  });

  test("drops punctuation-only transcriptReady text before it reaches the live session or outbox", () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    source.handleTranscriptReadyForTest({
      platform: "ios",
      wavId: "wav-punctuation",
      burstId: "burst-punctuation",
      captureSessionId: "capture-punctuation",
      text: ". . ...",
      capturedAt: "2026-05-10T12:00:00.000Z",
      durationMs: 500,
      provider: "cloud_whisper",
      fallback: false,
    });

    expect(pushed).toEqual([]);
    expect(getAmbientLiveTranscriptSnapshot()).toBeNull();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      "sound_classifier",
      "discard:meaningless_text burst=burst-punctuation",
    );
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({
      wavId: "wav-punctuation",
    });
  });

  test("drops filler-only captureReady transcription and marks the capture processed", async () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: ". . Hello. Yes. ... Ok OK. The",
      selfText: "",
      speakerLabels: [],
      segments: [],
      diarizationStatus: "fallback_plain_text",
      provider: "cloud_whisper",
      event: {},
    });

    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-filler",
      burstId: "burst-filler",
      captureSessionId: "capture-filler",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
      triggerSource: "audio_vad_fallback",
    });

    expect(pushed).toEqual([]);
    expect(getAmbientLiveTranscriptSnapshot()).toBeNull();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      "sound_classifier",
      "discard:meaningless_text burst=burst-filler",
    );
    expect(ambientAiMock.audio.markCaptureProcessed).toHaveBeenCalledWith({ wavId: "wav-filler" });
  });

  test("trims leading and trailing filler while keeping meaningful mixed transcript text", async () => {
    vi.setSystemTime(new Date("2026-05-17T05:15:30.000Z"));
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    captureTranscriptionMock.transcribeAmbientCapture.mockResolvedValue({
      text: "Hello ... Jesus. . . Hello.. Hmm. 我刚才又把所有中文的地方都翻成英文了。 ...... Hello.",
      selfText: "",
      speakerLabels: [],
      segments: [],
      diarizationStatus: "fallback_plain_text",
      provider: "cloud_whisper",
      event: {},
    });

    await source.handleCaptureReadyForTest({
      platform: "ios",
      wavId: "wav-mixed",
      burstId: "burst-mixed",
      captureSessionId: "capture-mixed",
      capturedAt: "2026-05-17T05:15:12.000Z",
      durationMs: 3500,
      byteSize: 320_000,
      triggerSource: "audio_vad_fallback",
    });

    expect(pushed).toEqual([
      expect.objectContaining({
        kind: "session_summary",
        summary: "我刚才又把所有中文的地方都翻成英文了。",
        dedupe_key: "ios:audio:burst-mixed",
      }),
    ]);
    expect(getAmbientLiveTranscriptSnapshot()).toMatchObject({
      captureSessionId: "capture-mixed",
      messages: [{
        id: "burst-mixed",
        text: "我刚才又把所有中文的地方都翻成英文了。",
        source: "cloud_whisper",
      }],
    });
    expect(ctx.onEvent).toHaveBeenCalledWith(
      "sound_classifier",
      "Voice transcript: 我刚才又把所有中文的地方都翻成英文了。",
    );
    vi.useRealTimers();
  });

  test("drops empty-after-trim transcriptReady text with a discard counter", () => {
    const pushed: unknown[] = [];
    const ctx: SourceContext = {
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);

    source.handleTranscriptReadyForTest({
      platform: "ios",
      wavId: "wav-blank",
      burstId: "burst-blank",
      captureSessionId: "capture-blank",
      text: "   ",
      capturedAt: "2026-05-10T12:00:00.000Z",
      durationMs: 500,
      provider: "cloud_whisper",
      fallback: false,
    });

    expect(pushed).toEqual([]);
    expect(ctx.onEvent).toHaveBeenCalledWith(
      "sound_classifier",
      "discard:empty_text burst=burst-blank",
    );
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
        schema_version: "sound_scene_run.v2",
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
      preRollMs: 2000,
      postRollMs: 5000,
      maxBurstMs: 30000,
      minBurstMs: 1000,
      sessionSilenceGapMs: 30000,
      maxSessionDurationMs: 300000,
    });
    expect(ambientAiMock.listenerRemove).toHaveBeenCalledTimes(5);
    expect(ambientAiMock.sound.stopClassification).toHaveBeenCalledTimes(1);
    expect(ambientAiMock.audio.stopCapture).toHaveBeenCalledTimes(1);
    expect(source.isStarted()).toBe(false);
  });

  test("cleans up registered listeners when later listener registration fails", async () => {
    const ctx: SourceContext = {
      push: vi.fn(),
      onEvent: vi.fn(),
    };
    const source = new SoundClassifierSource(ctx);
    ambientAiMock.setFailListenerEventName("audioState");

    await expect(source.start()).rejects.toThrow("listener failed: audioState");

    expect(ambientAiMock.listenerRemove).toHaveBeenCalledTimes(4);
    expect(ambientAiMock.audio.startCapture).not.toHaveBeenCalled();
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

  test("refresh does not restart while native audio is intentionally playback-suppressed", async () => {
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
      suppressedReason: "playback",
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
