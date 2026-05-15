import {
  AmbientAi,
  type SoundClassificationEvent,
  type TranscriptReadyEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import type { AmbientSource, SourceContext } from "./types";
import { SoundRunAggregator } from "./sound-runs";

export interface SoundClassifierOptions {
  /** Min top-1 confidence (0-1) before we even consider emitting. */
  minConfidence?: number;
  /** Collapse repeats of the same top label inside this window (ms). */
  dedupeWindowMs?: number;
}

const DEFAULT_OPTS: Required<SoundClassifierOptions> = {
  minConfidence: 0.5,
  dedupeWindowMs: 4_000,
};

const MIN_TRANSCRIPT_LENGTH = 24;
const TRANSCRIPT_SALIENCE = 0.7;
const TRANSCRIPT_CONFIDENCE = 0.75;
const SPEECH_LABEL = "speech";
const INTENTIONAL_SUPPRESSION_REASONS = new Set(["media", "playback"]);

/**
 * Wraps the SoundClassifier native plugin shipped via
 * `@pin/capacitor-ambient-ai`. The native plugin emits
 * top-3 classifications every ~1.5s window; we filter low-confidence
 * frames and collapse same-label runs so we don't drown the buffer
 * with `speech speech speech` ticks.
 */
export class SoundClassifierSource implements AmbientSource {
  readonly key = "sound_classifier";
  readonly label = "Sound Classifier";

  private listenerHandle: PluginListenerHandle | null = null;
  private transcriptListenerHandle: PluginListenerHandle | null = null;
  private started = false;
  private opts: Required<SoundClassifierOptions>;
  private runs = new SoundRunAggregator();

  constructor(
    private ctx: SourceContext,
    opts: SoundClassifierOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const perm = await AmbientAi.sound.requestPermissions();
    if (perm.microphone !== "granted") {
      throw new Error(`microphone permission ${perm.microphone}`);
    }
    this.listenerHandle = await AmbientAi.addListener(
      "soundClassification",
      (event) => this.handle(event),
    );
    this.transcriptListenerHandle = await AmbientAi.addListener(
      "transcriptReady",
      (event) => this.handleTranscriptReady(event),
    );
    try {
      await AmbientAi.audio.startCapture();
      await AmbientAi.sound.startClassification();
      this.started = true;
    } catch (err) {
      await this.cleanupNativeStartFailure();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await AmbientAi.sound.stopClassification();
      await AmbientAi.audio.stopCapture();
    } finally {
      const finalized = this.runs.stop();
      if (finalized) this.ctx.push(finalized);
      await this.removeListeners();
      this.started = false;
    }
  }

  async refresh(): Promise<void> {
    if (!this.started) return;
    const state = await AmbientAi.audio.getState();
    if (
      state.suppressed &&
      state.suppressedReason &&
      INTENTIONAL_SUPPRESSION_REASONS.has(state.suppressedReason)
    ) {
      return;
    }

    if (state.running && state.classificationRunning && state.engineRunning !== false) {
      return;
    }

    if (!state.running || state.engineRunning === false) {
      await AmbientAi.audio.startCapture();
    }
    if (!state.classificationRunning || state.engineRunning === false) {
      await AmbientAi.sound.startClassification();
    }

    const nextState = await AmbientAi.audio.getState();
    if (!nextState.running) {
      throw new Error("audio capture not running");
    }
    if (!nextState.classificationRunning) {
      throw new Error("sound classification not running");
    }
    if (nextState.engineRunning === false && !nextState.suppressed) {
      throw new Error("sound classifier engine not running");
    }
  }


  handleTranscriptReadyForTest(event: TranscriptReadyEvent): void {
    this.handleTranscriptReady(event);
  }

  handleSoundClassificationForTest(event: SoundClassificationEvent): void {
    this.handle(event);
  }

  private handleTranscriptReady(event: TranscriptReadyEvent): void {
    const text = event.text.trim();
    if (text.length < MIN_TRANSCRIPT_LENGTH) return;

    const payload: Record<string, unknown> = {
      platform: event.platform,
      wavId: event.wavId,
      burstId: event.burstId,
      captureSessionId: event.captureSessionId,
      durationMs: event.durationMs,
      provider: event.provider,
      fallback: event.fallback,
    };
    if (event.localProvider) payload.localProvider = event.localProvider;
    if (typeof event.segmentIndex === "number") {
      payload.segmentIndex = event.segmentIndex;
    }

    this.ctx.push({
      kind: "session_summary",
      title: "Voice summary",
      summary: text,
      occurred_at: event.capturedAt,
      payload,
      salience: TRANSCRIPT_SALIENCE,
      confidence: TRANSCRIPT_CONFIDENCE,
      dedupe_key: `${event.platform}:audio:${event.burstId}`,
    });
    this.ctx.onEvent(this.key, `Voice transcript: ${text}`);
  }

  private handle(event: SoundClassificationEvent): void {
    const top = event.classifications[0];
    if (!top) return;
    if (top.confidence < this.opts.minConfidence) return;

    if (top.label.toLowerCase() === SPEECH_LABEL) return;

    const emitted = this.runs.addSample({
      timestamp: event.timestamp,
      classifications: event.classifications.slice(0, 3).map((c) => ({
        label: c.label,
        confidence: c.confidence,
      })),
    });
    for (const item of emitted) {
      this.ctx.push(item);
      const label = typeof item.title === "string" ? item.title : top.label;
      this.ctx.onEvent(this.key, `${label} scene run`);
    }
  }

  private async cleanupNativeStartFailure(): Promise<void> {
    await Promise.allSettled([
      AmbientAi.sound.stopClassification(),
      AmbientAi.audio.stopCapture(),
    ]);
    await this.removeListeners();
    this.started = false;
  }

  private async removeListeners(): Promise<void> {
    const handles = [this.listenerHandle, this.transcriptListenerHandle]
      .filter((handle): handle is PluginListenerHandle => handle !== null);
    this.listenerHandle = null;
    this.transcriptListenerHandle = null;
    await Promise.all(handles.map((handle) => handle.remove()));
  }
}
