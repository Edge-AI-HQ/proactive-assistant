import {
  AmbientAi,
  type SoundClassificationEvent,
  type TranscriptReadyEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

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
  private lastTopLabel: string | null = null;
  private lastEmitTs = 0;
  private opts: Required<SoundClassifierOptions>;

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
    await AmbientAi.audio.startCapture();
    await AmbientAi.sound.startClassification();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await AmbientAi.sound.stopClassification();
      await AmbientAi.audio.stopCapture();
    } finally {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      if (this.transcriptListenerHandle) {
        await this.transcriptListenerHandle.remove();
        this.transcriptListenerHandle = null;
      }
      this.started = false;
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

    const now = Date.now();
    if (
      top.label === this.lastTopLabel &&
      now - this.lastEmitTs < this.opts.dedupeWindowMs
    ) {
      return;
    }
    this.lastTopLabel = top.label;
    this.lastEmitTs = now;

    const confPct = (top.confidence * 100).toFixed(1);
    const summary = `${top.label} (${confPct}%)`;
    this.ctx.push({
      kind: SIGNAL_KINDS.soundClassification,
      title: top.label,
      summary: `Top sound: ${summary}`,
      occurred_at: new Date(event.timestamp).toISOString(),
      payload: {
        top: event.classifications.slice(0, 3).map((c) => ({
          label: c.label,
          confidence: c.confidence,
        })),
      },
      confidence: top.confidence,
      // Bucket the timestamp by dedupeWindow so accidental client retries
      // still hash to the same key. If the user truly hears `speech` in
      // two adjacent windows, we only record the transition (intentional).
      dedupe_key: `sound:${top.label}:${Math.floor(event.timestamp / this.opts.dedupeWindowMs)}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}
