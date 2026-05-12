import { describe, expect, test, vi } from "vitest";

import { SoundClassifierSource } from "./sound-classifier";
import type { SourceContext } from "./types";

describe("SoundClassifierSource transcript ingest", () => {
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

  test("continues uploading non-speech classification ticks", () => {
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

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "device.sound_classification",
      title: "music",
      dedupe_key: "sound:music:444250000",
    });
    expect(ctx.onEvent).toHaveBeenCalledWith("sound_classifier", "music (81.0%)");
  });

});
