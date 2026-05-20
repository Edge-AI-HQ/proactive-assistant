import {
  AmbientAi,
  type CaptureReadyEvent,
  type RecentAudioCapture,
  type SoundClassificationEvent,
  type TranscriptReadyEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { normalizeVoiceLanguage } from "@/components/voice/language";
import type { AmbientSource, SourceContext } from "./types";
import { SoundRunAggregator } from "./sound-runs";
import { transcribeAmbientCapture } from "../capture-transcription";
import { applyAmbientLiveTranscriptUpdate } from "../live-transcript-store";

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
const DISABLED_TRANSCRIPT_PROVIDERS = new Set(["local_speech"]);
const LIVE_AUDIO_CONFIG = {
  preRollMs: 2_000,
  postRollMs: 2_500,
  maxBurstMs: 12_000,
  minBurstMs: 600,
  sessionSilenceGapMs: 30_000,
  maxSessionDurationMs: 5 * 60_000,
} as const;
const INTENTIONAL_SUPPRESSION_REASONS = new Set(["media", "playback"]);
const UNHEALTHY_ENGINE_STATES = new Set(["failed", "stale", "suspended"]);
const CLASSIFICATION_STALE_MS = 15_000;

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
  private captureReadyListenerHandle: PluginListenerHandle | null = null;
  private started = false;
  private opts: Required<SoundClassifierOptions>;
  private runs = new SoundRunAggregator();
  private storedTranscriptBurstIds = new Set<string>();
  private handledCaptureBurstIds = new Set<string>();
  private inFlightCaptureBurstIds = new Set<string>();
  private pendingAudioRecovery: Promise<void> | null = null;
  private recoveryRequestedWhileRunning = false;
  private activeRunId: number | null = null;
  private nextRunId = 0;

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
    await AmbientAi.audio.configure({
      ...LIVE_AUDIO_CONFIG,
      recognitionLocale: this.voiceLanguage().browser,
    });
    this.listenerHandle = await AmbientAi.addListener(
      "soundClassification",
      (event) => this.handle(event),
    );
    this.captureReadyListenerHandle = await AmbientAi.addListener(
      "captureReady",
      (event) => {
        void this.handleCaptureReady(event, this.activeRunId ?? undefined);
      },
    );
    this.transcriptListenerHandle = await AmbientAi.addListener(
      "transcriptReady",
      (event) => this.handleTranscriptReady(event, this.activeRunId ?? undefined),
    );
    const runId = this.beginRun();
    try {
      await AmbientAi.audio.startCapture();
      await AmbientAi.sound.startClassification();
      this.started = true;
      this.schedulePendingAudioRecovery("start");
    } catch (err) {
      if (this.activeRunId === runId) this.activeRunId = null;
      await this.cleanupNativeStartFailure();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.endRun();
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
      this.schedulePendingAudioRecovery("refreshSuppressed");
      return;
    }

    const analyzerUnhealthy = state.engineState !== undefined
      && UNHEALTHY_ENGINE_STATES.has(state.engineState);
    const classificationsStale = isClassificationStale(state.lastClassificationAt);
    if (
      state.running
      && state.classificationRunning
      && state.engineRunning !== false
      && !analyzerUnhealthy
      && !classificationsStale
    ) {
      this.schedulePendingAudioRecovery("refreshHealthy");
      return;
    }

    if (!state.running || state.engineRunning === false || analyzerUnhealthy || classificationsStale) {
      await AmbientAi.audio.startCapture();
    }
    if (!state.classificationRunning || state.engineRunning === false || analyzerUnhealthy || classificationsStale) {
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
    if (nextState.engineState && UNHEALTHY_ENGINE_STATES.has(nextState.engineState)) {
      throw new Error(`sound classifier engine ${nextState.engineState}`);
    }
    if (isClassificationStale(nextState.lastClassificationAt)) {
      throw new Error("sound classifier classifications stale");
    }
    this.schedulePendingAudioRecovery("refreshRecovered");
  }

  async flushPendingAudioRecoveryForTest(): Promise<void> {
    await this.pendingAudioRecovery;
  }

  private schedulePendingAudioRecovery(reason: string): void {
    const runId = this.activeRunId;
    if (runId === null) return;
    if (this.pendingAudioRecovery) {
      this.recoveryRequestedWhileRunning = true;
      return;
    }
    this.pendingAudioRecovery = this.recoverPendingAudioLoop(runId, reason)
      .catch((error) => {
        this.ctx.onEvent(this.key, `Pending audio recovery failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.pendingAudioRecovery = null;
      });
    void this.pendingAudioRecovery;
  }

  private async recoverPendingAudioLoop(runId: number, reason: string): Promise<void> {
    let currentReason = reason;
    do {
      this.recoveryRequestedWhileRunning = false;
      if (!this.isRunActive(runId)) return;
      await this.recoverPendingAudio(runId, currentReason);
      currentReason = "queuedRefresh";
    } while (this.recoveryRequestedWhileRunning && this.isRunActive(runId));
  }

  private async recoverPendingAudio(runId: number, reason: string): Promise<void> {
    await this.drainPendingNativeTranscripts(runId);
    if (!this.isRunActive(runId)) return;
    await this.transcribeUnhandledRecentCaptures(runId);
    if (!this.isRunActive(runId)) return;
    this.ctx.onEvent(this.key, `Recovered pending audio after ${reason}`);
  }

  private async drainPendingNativeTranscripts(runId: number): Promise<void> {
    let transcripts: TranscriptReadyEvent[];
    try {
      transcripts = await AmbientAi.audio.drainPendingTranscripts();
    } catch (error) {
      this.ctx.onEvent(this.key, `Pending transcript drain failed: ${errorMessage(error)}`);
      return;
    }
    if (!this.isRunActive(runId)) return;
    for (const event of transcripts) {
      if (!this.isRunActive(runId)) return;
      this.handleTranscriptReady(event, runId);
    }
  }

  private async transcribeUnhandledRecentCaptures(runId: number): Promise<void> {
    let captures: RecentAudioCapture[];
    try {
      ({ captures } = await AmbientAi.audio.listRecentCaptures());
    } catch (error) {
      this.ctx.onEvent(this.key, `Recent capture scan failed: ${errorMessage(error)}`);
      return;
    }
    if (!this.isRunActive(runId)) return;
    for (const capture of captures) {
      if (!this.isRunActive(runId)) return;
      if (!capture.burstId || !capture.captureSessionId) continue;
      if (this.storedTranscriptBurstIds.has(capture.burstId)) continue;
      if (this.handledCaptureBurstIds.has(capture.burstId)) continue;
      if (this.inFlightCaptureBurstIds.has(capture.burstId)) continue;
      await this.handleCaptureReady({
        platform: "ios",
        wavId: capture.wavId,
        burstId: capture.burstId,
        captureSessionId: capture.captureSessionId,
        capturedAt: capture.capturedAt,
        durationMs: capture.durationMs,
        byteSize: capture.byteSize,
        triggerSource: "recent_capture_scan",
      }, runId);
    }
  }


  handleTranscriptReadyForTest(event: TranscriptReadyEvent): void {
    this.handleTranscriptReady(event);
  }

  async handleCaptureReadyForTest(event: CaptureReadyEvent): Promise<void> {
    await this.handleCaptureReady(event);
  }

  handleSoundClassificationForTest(event: SoundClassificationEvent): void {
    this.handle(event);
  }

  private handleTranscriptReady(event: TranscriptReadyEvent, runId?: number): void {
    if (runId !== undefined && !this.isRunActive(runId)) return;
    if (DISABLED_TRANSCRIPT_PROVIDERS.has(event.provider)) {
      this.ctx.onEvent(this.key, `Ignored transcript provider: ${event.provider}`);
      return;
    }
    const text = event.text.trim();
    if (text.length < MIN_TRANSCRIPT_LENGTH) return;
    if (this.storedTranscriptBurstIds.has(event.burstId)) return;

    this.pushTranscript({
      event,
      text,
      provider: event.provider,
      fallback: event.fallback,
      localProvider: event.localProvider,
      segmentIndex: event.segmentIndex,
    });
    if (!this.inFlightCaptureBurstIds.has(event.burstId)) {
      void this.markCaptureProcessed(event.wavId);
    }
  }

  private async handleCaptureReady(event: CaptureReadyEvent, runId?: number): Promise<void> {
    if (runId !== undefined && !this.isRunActive(runId)) return;
    if (this.storedTranscriptBurstIds.has(event.burstId)) return;
    if (this.handledCaptureBurstIds.has(event.burstId)) return;
    if (this.inFlightCaptureBurstIds.has(event.burstId)) return;
    this.inFlightCaptureBurstIds.add(event.burstId);
    try {
      const result = await transcribeAmbientCapture(event, this.transcriptionLanguage());
      if (runId !== undefined && !this.isRunActive(runId)) return;
      const text = result.text.trim();
      if (!text) {
        this.handledCaptureBurstIds.add(event.burstId);
        await this.markCaptureProcessed(event.wavId);
        return;
      }
      this.handledCaptureBurstIds.add(event.burstId);

      applyAmbientLiveTranscriptUpdate({
        captureSessionId: event.captureSessionId,
        id: event.burstId,
        text,
        source: "cloud_whisper",
        receivedAt: Date.parse(event.capturedAt) || Date.now(),
      });

      if (text.length >= MIN_TRANSCRIPT_LENGTH && !this.storedTranscriptBurstIds.has(event.burstId)) {
        this.pushTranscript({
          event,
          text,
          provider: "cloud_whisper",
          fallback: false,
        });
      }
      await this.markCaptureProcessed(event.wavId);
    } catch (error) {
      applyAmbientLiveTranscriptUpdate({
        captureSessionId: event.captureSessionId,
        id: event.burstId,
        text: "Transcription unavailable",
        source: "microphone",
        receivedAt: Date.now(),
      });
      this.ctx.onEvent(this.key, `Voice transcription failed: ${errorMessage(error)}`);
      if (this.storedTranscriptBurstIds.has(event.burstId)) {
        await this.markCaptureProcessed(event.wavId);
      }
    } finally {
      this.inFlightCaptureBurstIds.delete(event.burstId);
    }
  }

  private beginRun(): number {
    this.nextRunId += 1;
    this.activeRunId = this.nextRunId;
    this.recoveryRequestedWhileRunning = false;
    return this.activeRunId;
  }

  private endRun(): void {
    this.activeRunId = null;
    this.recoveryRequestedWhileRunning = false;
  }

  private isRunActive(runId: number): boolean {
    return this.started && this.activeRunId === runId;
  }

  private async markCaptureProcessed(wavId: string): Promise<void> {
    try {
      await AmbientAi.audio.markCaptureProcessed({ wavId });
    } catch (error) {
      this.ctx.onEvent(this.key, `Processed capture cleanup failed: ${errorMessage(error)}`);
    }
  }

  private pushTranscript(input: {
    event: TranscriptReadyEvent | CaptureReadyEvent;
    text: string;
    provider: string;
    fallback: boolean;
    localProvider?: string;
    segmentIndex?: number;
  }): void {
    const { event, text } = input;
    const payload: Record<string, unknown> = {
      platform: event.platform,
      wavId: event.wavId,
      burstId: event.burstId,
      captureSessionId: event.captureSessionId,
      durationMs: event.durationMs,
      provider: input.provider,
      fallback: input.fallback,
    };
    if (input.localProvider) payload.localProvider = input.localProvider;
    if (typeof input.segmentIndex === "number") {
      payload.segmentIndex = input.segmentIndex;
    }
    if (event.triggerSource) payload.triggerSource = event.triggerSource;

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
    this.storedTranscriptBurstIds.add(event.burstId);
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

  private voiceLanguage() {
    return normalizeVoiceLanguage(this.ctx.getTranscriptionLanguage?.());
  }

  private transcriptionLanguage(): string | undefined {
    return this.voiceLanguage().openai;
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
    const handles = [this.listenerHandle, this.captureReadyListenerHandle, this.transcriptListenerHandle]
      .filter((handle): handle is PluginListenerHandle => handle !== null);
    this.listenerHandle = null;
    this.captureReadyListenerHandle = null;
    this.transcriptListenerHandle = null;
    await Promise.all(handles.map((handle) => handle.remove()));
  }
}

function isClassificationStale(lastClassificationAt: number | undefined): boolean {
  return typeof lastClassificationAt === "number"
    && Date.now() - lastClassificationAt > CLASSIFICATION_STALE_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
