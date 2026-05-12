import {
  AmbientAi,
  type ActivityEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

/**
 * Wraps the CMMotionActivity side of the VisitMonitor native plugin
 * (shipped via `@pin/capacitor-ambient-ai`).
 *
 * CMMotionActivity is sticky: it re-emits the same state when nothing
 * changed. We only push a signal on transitions (type or confidence
 * changed) so we don't drown the buffer with `stationary stationary
 * stationary`.
 */
export class ActivitySource implements AmbientSource {
  readonly key = "activity";
  readonly label = "Motion Activity";

  private listenerHandle: PluginListenerHandle | null = null;
  private started = false;
  private lastType: ActivityEvent["type"] | null = null;
  private lastConfidence: ActivityEvent["confidence"] | null = null;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.listenerHandle = await AmbientAi.addListener(
      "activity",
      (event) => this.handle(event),
    );
    await AmbientAi.visit.startActivityRecognition();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await AmbientAi.visit.stopActivityRecognition();
    } finally {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      this.started = false;
    }
  }

  private handle(event: ActivityEvent): void {
    if (
      event.type === this.lastType &&
      event.confidence === this.lastConfidence
    ) {
      return;
    }
    this.lastType = event.type;
    this.lastConfidence = event.confidence;

    const summary = `${event.type} (${event.confidence})`;
    this.ctx.push({
      kind: SIGNAL_KINDS.activity,
      title: `Motion: ${event.type}`,
      summary,
      occurred_at: new Date(event.timestamp).toISOString(),
      payload: {
        type: event.type,
        confidence: event.confidence,
      },
      // Bucket per minute on a transition so accidental retries dedupe
      // but a real type-change inside the minute still emits.
      dedupe_key: `activity:${event.type}:${Math.floor(event.timestamp / 60_000)}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}
