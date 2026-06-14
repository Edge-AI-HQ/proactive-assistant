// Pure sound scene-run aggregation (lifted from web
// services/ambient/sources/sound-runs.ts). Dedupes streaming sound
// classifications into stable PersonalSignal scene-run drafts — no platform
// SDK, no DOM. The native sound classifier source stays in each app and feeds
// samples into this aggregator. Web re-exports from here so existing
// `@/services/ambient/sources/sound-runs` importers are unaffected.
import type { PersonalSignalInput } from "../signals";
import { SIGNAL_KINDS } from "../signals";

export interface SoundRunSample {
  timestamp: number;
  classifications: Array<{ label: string; confidence: number }>;
}

export interface SoundRunAggregatorOptions {
  minDurationMs?: number;
  minSampleCount?: number;
  maxGapMs?: number;
  periodicUpdateMs?: number;
}

const DEFAULT_OPTIONS: Required<SoundRunAggregatorOptions> = {
  minDurationMs: 15_000,
  minSampleCount: 3,
  maxGapMs: 20_000,
  periodicUpdateMs: 60_000,
};

interface OpenSoundRun {
  label: string;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  maxConfidence: number;
  latestTop: Array<{ label: string; confidence: number }>;
  lastPushedAt: number | null;
}

export class SoundRunAggregator {
  private current: OpenSoundRun | null = null;
  private options: Required<SoundRunAggregatorOptions>;

  constructor(options: SoundRunAggregatorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  addSample(sample: SoundRunSample): PersonalSignalInput[] {
    const top = sample.classifications[0];
    if (!top) return [];
    const label = normalizeLabel(top.label);
    const output: PersonalSignalInput[] = [];
    if (
      this.current
      && this.current.label === label
      && sample.timestamp - this.current.endedAt <= this.options.maxGapMs
    ) {
      this.extendCurrent(sample, label);
      const periodic = this.periodicSignal();
      if (periodic) output.push(periodic);
      return output;
    }

    const finalized = this.finalize();
    if (finalized) output.push(finalized);
    this.current = {
      label,
      startedAt: sample.timestamp,
      endedAt: sample.timestamp,
      sampleCount: 1,
      maxConfidence: top.confidence,
      latestTop: normalizeClassifications(sample.classifications).slice(0, 3),
      lastPushedAt: null,
    };
    return output;
  }

  stop(): PersonalSignalInput | null {
    return this.finalize();
  }

  private extendCurrent(sample: SoundRunSample, label: string): void {
    if (!this.current) return;
    const top = sample.classifications[0];
    this.current = {
      ...this.current,
      label,
      endedAt: sample.timestamp,
      sampleCount: this.current.sampleCount + 1,
      maxConfidence: Math.max(this.current.maxConfidence, top?.confidence ?? 0),
      latestTop: normalizeClassifications(sample.classifications).slice(0, 3),
    };
  }

  private periodicSignal(): PersonalSignalInput | null {
    if (!this.current || !this.isEligible(this.current)) return null;
    if (
      this.current.lastPushedAt !== null
      && this.current.endedAt - this.current.lastPushedAt < this.options.periodicUpdateMs
    ) {
      return null;
    }
    this.current.lastPushedAt = this.current.endedAt;
    return signalFromRun(this.current);
  }

  private finalize(): PersonalSignalInput | null {
    const run = this.current;
    this.current = null;
    if (!run || !this.isEligible(run)) return null;
    return signalFromRun(run);
  }

  private isEligible(run: OpenSoundRun): boolean {
    return run.endedAt - run.startedAt >= this.options.minDurationMs
      && run.sampleCount >= this.options.minSampleCount;
  }
}

function signalFromRun(run: OpenSoundRun): PersonalSignalInput {
  const startedAt = new Date(run.startedAt).toISOString();
  const endedAt = new Date(run.endedAt).toISOString();
  const runId = `sound:${run.label}:${startedAt}`;
  const displayLabel = displayLabelForSound(run.label);
  return {
    kind: SIGNAL_KINDS.soundSceneRun,
    title: run.label,
    summary: `Heard ${displayLabel}`,
    occurred_at: startedAt,
    payload: {
      schema_version: "sound_scene_run.v2",
      runId,
      label: run.label,
      primaryLabel: run.label,
      displayLabel,
      started_at: startedAt,
      ended_at: endedAt,
      durationMs: run.endedAt - run.startedAt,
      sampleCount: run.sampleCount,
      maxConfidence: run.maxConfidence,
      sourceConfidence: run.maxConfidence,
      top: run.latestTop,
      topCandidates: run.latestTop,
    },
    confidence: run.maxConfidence,
    dedupe_key: runId,
  };
}

function normalizeClassifications(
  classifications: Array<{ label: string; confidence: number }>,
): Array<{ label: string; confidence: number }> {
  return classifications.map((item) => ({
    label: normalizeLabel(item.label),
    confidence: item.confidence,
  }));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function displayLabelForSound(label: string): string {
  const text = label
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return text ? text.replace(/^./, (char) => char.toUpperCase()) : "Sound";
}
