import type { ActivityEvent } from "@pin/capacitor-ambient-ai";
import type { PersonalSignalInput } from "@/lib/devices";
import { SIGNAL_KINDS } from "../kinds";

export interface MotionSegmentAggregatorOptions {
  transitionConfirmMs?: number;
  periodicUpdateMs?: number;
}

const DEFAULT_OPTIONS: Required<MotionSegmentAggregatorOptions> = {
  transitionConfirmMs: 30_000,
  periodicUpdateMs: 60_000,
};

type ActivityType = ActivityEvent["type"];
type ActivityConfidence = ActivityEvent["confidence"];

interface MotionSegment {
  activity: ActivityType;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  maxConfidence: ActivityConfidence;
  lastConfidence: ActivityConfidence;
  lastPushedAt: number | null;
}

interface PendingTransition {
  activity: ActivityType;
  confidence: ActivityConfidence;
  startedAt: number;
  sampleCount: number;
}

export class MotionSegmentAggregator {
  private current: MotionSegment | null = null;
  private pending: PendingTransition | null = null;
  private options: Required<MotionSegmentAggregatorOptions>;

  constructor(options: MotionSegmentAggregatorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  addSample(event: ActivityEvent): PersonalSignalInput[] {
    const output: PersonalSignalInput[] = [];
    if (!this.current) {
      this.current = this.newSegment(event);
      return output;
    }

    if (event.type === this.current.activity) {
      this.pending = null;
      this.extendCurrent(event);
      return output;
    }

    if (!this.pending || this.pending.activity !== event.type) {
      this.pending = {
        activity: event.type,
        confidence: event.confidence,
        startedAt: event.timestamp,
        sampleCount: 1,
      };
      return output;
    }

    this.pending.sampleCount += 1;
    this.pending.confidence = maxConfidence(this.pending.confidence, event.confidence);
    if (
      event.timestamp - this.pending.startedAt >= this.options.transitionConfirmMs
      || this.pending.sampleCount >= 2
    ) {
      const finalized = this.finalizeCurrent(this.pending.startedAt);
      if (finalized) output.push(finalized);
      this.current = this.newSegment({
        type: this.pending.activity,
        confidence: this.pending.confidence,
        timestamp: this.pending.startedAt,
      });
      this.extendCurrent(event);
      this.pending = null;
    }
    return output;
  }

  stop(): PersonalSignalInput | null {
    this.pending = null;
    return this.finalizeCurrent(this.current?.endedAt ?? null);
  }

  private newSegment(event: ActivityEvent): MotionSegment {
    return {
      activity: event.type,
      startedAt: event.timestamp,
      endedAt: event.timestamp,
      sampleCount: 1,
      maxConfidence: event.confidence,
      lastConfidence: event.confidence,
      lastPushedAt: null,
    };
  }

  private extendCurrent(event: ActivityEvent): void {
    if (!this.current) return;
    this.current = {
      ...this.current,
      endedAt: event.timestamp,
      sampleCount: this.current.sampleCount + 1,
      maxConfidence: maxConfidence(this.current.maxConfidence, event.confidence),
      lastConfidence: event.confidence,
    };
  }

  private periodicSignal(): PersonalSignalInput | null {
    if (!this.current) return null;
    if (
      this.current.lastPushedAt !== null
      && this.current.endedAt - this.current.lastPushedAt < this.options.periodicUpdateMs
    ) {
      return null;
    }
    this.current.lastPushedAt = this.current.endedAt;
    return signalFromSegment(this.current);
  }

  private finalizeCurrent(endedAt: number | null): PersonalSignalInput | null {
    if (!this.current) return null;
    const segment = { ...this.current, endedAt: endedAt ?? this.current.endedAt };
    this.current = null;
    return signalFromSegment(segment);
  }
}

function signalFromSegment(segment: MotionSegment): PersonalSignalInput {
  const startedAt = new Date(segment.startedAt).toISOString();
  const endedAt = new Date(segment.endedAt).toISOString();
  const segmentId = `motion:${segment.activity}:${startedAt}`;
  return {
    kind: SIGNAL_KINDS.motionSegment,
    title: `Motion: ${segment.activity}`,
    summary: `${segment.activity} (${segment.lastConfidence})`,
    occurred_at: startedAt,
    payload: {
      schema_version: "motion_segment.v1",
      segmentId,
      activity: segment.activity,
      started_at: startedAt,
      ended_at: endedAt,
      durationMs: segment.endedAt - segment.startedAt,
      sampleCount: segment.sampleCount,
      maxConfidence: segment.maxConfidence,
      lastConfidence: segment.lastConfidence,
    },
    dedupe_key: segmentId,
  };
}

function maxConfidence(a: ActivityConfidence, b: ActivityConfidence): ActivityConfidence {
  const rank: Record<ActivityConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[b] > rank[a] ? b : a;
}
