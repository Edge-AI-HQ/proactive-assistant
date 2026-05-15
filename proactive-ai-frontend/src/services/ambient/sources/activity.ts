import {
  AmbientAi,
  type ActivityEvent,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import type { AmbientSource, SourceContext } from "./types";
import { MotionSegmentAggregator } from "./motion-segments";

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
  private segments = new MotionSegmentAggregator();

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
      const finalized = this.segments.stop();
      if (finalized) this.ctx.push(finalized);
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      this.started = false;
    }
  }

  handleActivityForTest(event: ActivityEvent): void {
    this.handle(event);
  }

  private handle(event: ActivityEvent): void {
    const emitted = this.segments.addSample(event);
    for (const item of emitted) {
      this.ctx.push(item);
      this.ctx.onEvent(this.key, item.summary);
    }
  }
}
