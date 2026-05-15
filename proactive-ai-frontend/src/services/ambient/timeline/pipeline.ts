import type { PersonalSignalInput } from "@/lib/devices";
import { timelineEventToSignal } from "./envelope";
import { rawEventFromSignal, placeLabel } from "./normalize";
import { getAmbientTimelineStore } from "./store";
import type {
  AmbientCandidateWindow,
  AmbientPrivacy,
  AmbientRawEvent,
  AmbientRawRef,
  AmbientSourceType,
  AmbientTimelineEvent,
  AmbientTimelineStore,
  AmbientWindowType,
} from "./types";
import { AMBIENT_TIMELINE_SCHEMA_VERSION } from "./types";
import {
  LOCAL_USER_ID,
  clamp01,
  currentTimezone,
  localDateFromDate,
  localDateFromIso,
  maxPrivacy,
  sourceLabel,
  stableHash,
  stableId,
  uniqueRawRefs,
  uniqueStrings,
} from "./utils";

export interface AmbientTimelinePipeline {
  ingestSignal(item: PersonalSignalInput): Promise<PersonalSignalInput[]>;
  regenerateDay(localDate?: string): Promise<PersonalSignalInput[]>;
}

export interface AmbientTimelinePipelineOptions {
  store?: AmbientTimelineStore;
}

export class LocalAmbientTimelinePipeline implements AmbientTimelinePipeline {
  constructor(private store: AmbientTimelineStore = getAmbientTimelineStore()) {}

  async ingestSignal(item: PersonalSignalInput): Promise<PersonalSignalInput[]> {
    const raw = await this.store.upsertRawEvent(rawEventFromSignal(item));
    return this.generateForRaw(raw);
  }

  async regenerateDay(localDate = localDateFromDate(new Date())): Promise<PersonalSignalInput[]> {
    await this.store.init();
    const raws = await this.store.listRawEvents({ localDate, limit: 1_000 });
    const out: PersonalSignalInput[] = [];
    for (const raw of raws) {
      out.push(...await this.generateForRaw(raw));
    }
    return out;
  }

  private async generateForRaw(raw: AmbientRawEvent): Promise<PersonalSignalInput[]> {
    const signals: PersonalSignalInput[] = [];
    if (raw.sourceType === "health") {
      const generated = await this.generateMorningHealth(raw.localDate);
      if (generated) signals.push(generated);
      return signals;
    }
    if (raw.sourceType === "visit") {
      const visit = await this.generateVisitStay(raw);
      if (visit) signals.push(visit);
      const transition = await this.generateTransition(raw);
      if (transition) signals.push(transition);
      return signals;
    }
    if (raw.sourceType === "transcript") {
      await this.upsertTranscriptWindow(raw);
      return signals;
    }
    return signals;
  }

  private async generateMorningHealth(localDate: string): Promise<PersonalSignalInput | null> {
    const raws = await this.store.listRawEvents({
      localDate,
      sourceType: "health",
      limit: 200,
    });
    if (raws.length === 0) return null;
    const startedAt = raws[0]?.occurredAt ?? new Date().toISOString();
    const refs = raws.map(rawRef);
    const facts = healthFacts(raws);
    const compactContext = facts.length > 0
      ? facts.join(" ")
      : "HealthKit reported a health summary for the morning.";
    const window = await this.upsertWindow({
      id: stableId("win", ["morning_health", localDate]),
      localDate,
      windowType: "morning_health",
      startedAt,
      endedAt: raws[raws.length - 1]?.endedAt ?? raws[raws.length - 1]?.occurredAt,
      sourceTypes: ["health"],
      deviceLabels: ["HealthKit"],
      rawRefs: refs,
      compactContext,
      privacyHint: "sensitive",
      confidenceHint: 0.82,
      salienceHint: 0.72,
      generationPolicy: "rule_only",
      status: "generated",
    });
    const tags = uniqueStrings([
      "health",
      ...raws.flatMap((raw) => healthMetricTags(raw.payload)),
    ]);
    const event = makeEvent({
      id: stableId("evt", ["morning_health", localDate]),
      localDate,
      occurredAt: startedAt,
      eventType: "morning",
      title: "Morning health",
      summary: compactContext,
      primarySourceLabel: "HealthKit",
      deviceLabels: ["HealthKit"],
      sourceTypes: ["health"],
      tags,
      privacy: "sensitive",
      confidence: 0.82,
      salience: 0.72,
      rawRefs: refs,
      windowId: window.id,
      dedupeKey: `ambient:timeline:${localDate}:morning_health`,
    });
    return this.upsertVisibleEvent(event);
  }

  private async generateVisitStay(raw: AmbientRawEvent): Promise<PersonalSignalInput | null> {
    const place = placeLabel(raw.payload);
    if (!place) return null;
    const isDeparture = raw.eventType === "visit.departure";
    const title = isDeparture ? `Stayed near ${place}` : `Arrived near ${place}`;
    const summary = isDeparture
      ? `Visit signals indicate a stay near ${place} until ${formatTime(raw.occurredAt)}.`
      : `Visit signals indicate arrival near ${place} around ${formatTime(raw.occurredAt)}.`;
    const refs = [rawRef(raw)];
    const window = await this.upsertWindow({
      id: stableId("win", ["visit_stay", raw.id]),
      localDate: raw.localDate,
      windowType: "visit_stay",
      startedAt: raw.occurredAt,
      endedAt: raw.endedAt,
      sourceTypes: ["visit"],
      deviceLabels: ["iPhone"],
      rawRefs: refs,
      compactContext: summary,
      privacyHint: "private",
      confidenceHint: 0.78,
      salienceHint: 0.6,
      generationPolicy: "rule_only",
      status: "generated",
    });
    const event = makeEvent({
      id: stableId("evt", ["visit_stay", raw.id]),
      localDate: raw.localDate,
      occurredAt: raw.occurredAt,
      endedAt: raw.endedAt,
      eventType: "visit",
      title,
      summary,
      primarySourceLabel: sourceLabel("visit"),
      deviceLabels: ["iPhone"],
      sourceTypes: ["visit"],
      tags: ["visit", "location"],
      privacy: "private",
      confidence: 0.78,
      salience: 0.6,
      rawRefs: refs,
      windowId: window.id,
      dedupeKey: `ambient:timeline:${raw.localDate}:visit:${stableHash(raw.dedupeKey)}`,
    });
    return this.upsertVisibleEvent(event);
  }

  private async generateTransition(raw: AmbientRawEvent): Promise<PersonalSignalInput | null> {
    if (raw.eventType !== "visit.arrival") return null;
    const toPlace = placeLabel(raw.payload);
    if (!toPlace) return null;
    const visits = await this.store.listRawEvents({
      localDate: raw.localDate,
      sourceType: "visit",
      limit: 200,
    });
    const earlier = visits
      .filter((candidate) => Date.parse(candidate.occurredAt) < Date.parse(raw.occurredAt))
      .reverse()
      .find((candidate) => placeLabel(candidate.payload));
    if (!earlier) return null;
    const fromPlace = placeLabel(earlier.payload);
    if (!fromPlace || fromPlace === toPlace) return null;
    const motionRaws = await this.motionBetween(
      raw.localDate,
      earlier.occurredAt,
      raw.occurredAt,
    );
    const refs = uniqueRawRefs([
      rawRef(earlier),
      ...motionRaws.map(rawRef),
      rawRef(raw),
    ]);
    const sourceTypes = uniqueSourceTypes([
      "visit",
      ...motionRaws.map((item) => item.sourceType),
    ]);
    const summary = motionRaws.length > 0
      ? `Left near ${fromPlace} and arrived near ${toPlace} around ${formatTime(raw.occurredAt)}. Motion signals matched the transition.`
      : `Visit signals indicate movement from near ${fromPlace} to near ${toPlace} around ${formatTime(raw.occurredAt)}.`;
    const window = await this.upsertWindow({
      id: stableId("win", ["transition", earlier.id, raw.id]),
      localDate: raw.localDate,
      windowType: "transition",
      startedAt: earlier.endedAt ?? earlier.occurredAt,
      endedAt: raw.occurredAt,
      sourceTypes,
      deviceLabels: ["iPhone"],
      rawRefs: refs,
      compactContext: summary,
      privacyHint: "private",
      confidenceHint: motionRaws.length > 0 ? 0.82 : 0.74,
      salienceHint: 0.66,
      generationPolicy: "rule_only",
      status: "generated",
    });
    const event = makeEvent({
      id: stableId("evt", ["transition", earlier.id, raw.id]),
      localDate: raw.localDate,
      occurredAt: earlier.endedAt ?? earlier.occurredAt,
      endedAt: raw.occurredAt,
      eventType: "transition",
      title: `${fromPlace} → ${toPlace}`,
      summary,
      primarySourceLabel: "iPhone",
      deviceLabels: ["iPhone"],
      sourceTypes,
      tags: ["transition", "location"],
      privacy: "private",
      confidence: motionRaws.length > 0 ? 0.82 : 0.74,
      salience: 0.66,
      rawRefs: refs,
      windowId: window.id,
      dedupeKey: `ambient:timeline:${raw.localDate}:transition:${stableHash(`${earlier.id}:${raw.id}`)}`,
    });
    return this.upsertVisibleEvent(event);
  }

  private async upsertTranscriptWindow(raw: AmbientRawEvent): Promise<void> {
    const durationMs = numberPayload(raw.payload, "durationMs");
    const startedAt = raw.occurredAt;
    const endedAt = raw.endedAt
      ?? (durationMs
        ? new Date(Date.parse(startedAt) + durationMs).toISOString()
        : undefined);
    await this.upsertWindow({
      id: stableId("win", ["transcript_session", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "transcript_session",
      startedAt,
      endedAt,
      sourceTypes: ["transcript"],
      deviceLabels: ["Microphone"],
      rawRefs: [rawRef(raw)],
      compactContext: raw.compactText,
      privacyHint: "private",
      confidenceHint: 0.55,
      salienceHint: 0.5,
      generationPolicy: "llm_allowed",
      status: "pending",
      llmInputHash: stableHash(raw.compactText),
    });
  }

  private async motionBetween(
    localDate: string,
    start: string,
    end: string,
  ): Promise<AmbientRawEvent[]> {
    const startTs = Date.parse(start);
    const endTs = Date.parse(end);
    const motions = await this.store.listRawEvents({
      localDate,
      sourceType: "motion",
      limit: 200,
    });
    return motions.filter((raw) => {
      const ts = Date.parse(raw.occurredAt);
      return Number.isFinite(ts) && ts >= startTs && ts <= endTs;
    });
  }

  private async upsertWindow(args: {
    id: string;
    localDate: string;
    windowType: AmbientWindowType;
    startedAt: string;
    endedAt?: string;
    sourceTypes: AmbientSourceType[];
    deviceLabels: string[];
    rawRefs: AmbientRawRef[];
    compactContext: string;
    privacyHint: AmbientCandidateWindow["privacyHint"];
    confidenceHint: number;
    salienceHint: number;
    generationPolicy: AmbientCandidateWindow["generationPolicy"];
    status: AmbientCandidateWindow["status"];
    llmInputHash?: string | null;
  }): Promise<AmbientCandidateWindow> {
    const now = new Date().toISOString();
    return this.store.upsertCandidateWindow({
      id: args.id,
      localUserId: LOCAL_USER_ID,
      localDate: args.localDate,
      windowType: args.windowType,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      timezone: currentTimezone(),
      sourceTypes: uniqueSourceTypes(args.sourceTypes),
      deviceLabels: uniqueStrings(args.deviceLabels),
      rawRefs: uniqueRawRefs(args.rawRefs),
      observationIds: [],
      compactContext: args.compactContext,
      privacyHint: args.privacyHint,
      confidenceHint: clamp01(args.confidenceHint),
      salienceHint: clamp01(args.salienceHint),
      generationPolicy: args.generationPolicy,
      llmInputHash: args.llmInputHash ?? null,
      status: args.status,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async upsertVisibleEvent(
    event: AmbientTimelineEvent,
  ): Promise<PersonalSignalInput | null> {
    const result = await this.store.upsertTimelineEvent(event);
    return result.shouldSync ? timelineEventToSignal(result.event) : null;
  }
}

export function createAmbientTimelinePipeline(
  options: AmbientTimelinePipelineOptions = {},
): AmbientTimelinePipeline {
  return new LocalAmbientTimelinePipeline(options.store);
}

let singleton: AmbientTimelinePipeline | null = null;

export function getAmbientTimelinePipeline(): AmbientTimelinePipeline {
  if (!singleton) singleton = createAmbientTimelinePipeline();
  return singleton;
}

function makeEvent(args: {
  id: string;
  localDate: string;
  occurredAt: string;
  endedAt?: string;
  eventType: AmbientTimelineEvent["eventType"];
  title: string;
  summary: string;
  primarySourceLabel: string;
  deviceLabels: string[];
  sourceTypes: AmbientSourceType[];
  tags: string[];
  privacy?: AmbientTimelineEvent["privacy"];
  confidence: number;
  salience: number;
  rawRefs: AmbientRawRef[];
  windowId?: string;
  dedupeKey: string;
}): AmbientTimelineEvent {
  const now = new Date().toISOString();
  const privacyValues: AmbientPrivacy[] = args.sourceTypes.map((source) => {
    if (source === "health") return "sensitive";
    if (source === "location" || source === "visit" || source === "transcript") {
      return "private";
    }
    return "normal";
  });
  const privacy = args.privacy ?? maxPrivacy(privacyValues);
  const confidence = clamp01(args.confidence);
  return {
    id: args.id,
    localUserId: LOCAL_USER_ID,
    localDate: args.localDate,
    timezone: currentTimezone(),
    occurredAt: args.occurredAt,
    endedAt: args.endedAt,
    eventType: args.eventType,
    title: args.title,
    summary: args.summary,
    primarySourceLabel: args.primarySourceLabel,
    deviceLabels: uniqueStrings(args.deviceLabels),
    sourceTypes: uniqueSourceTypes(args.sourceTypes),
    tags: uniqueStrings(args.tags),
    privacy,
    confidence,
    confidenceLabel: confidence >= 0.65 ? "certain" : "uncertain",
    salience: clamp01(args.salience),
    rawRefs: uniqueRawRefs(args.rawRefs),
    observationIds: [],
    windowId: args.windowId,
    generationMethod: "rule",
    generationStatus: "visible",
    memoryCandidate: false,
    cardTriggerCandidate: false,
    schemaVersion: AMBIENT_TIMELINE_SCHEMA_VERSION,
    syncStatus: "pending",
    dedupeKey: args.dedupeKey,
    createdAt: now,
    updatedAt: now,
  };
}

function rawRef(raw: AmbientRawEvent): AmbientRawRef {
  return { sourceType: raw.sourceType, id: raw.id };
}

function healthFacts(raws: AmbientRawEvent[]): string[] {
  const metrics = uniqueStrings(raws.flatMap((raw) => healthMetricTags(raw.payload)));
  const facts: string[] = [];
  if (metrics.includes("sleep")) {
    facts.push("Sleep summary is available.");
  }
  if (metrics.includes("heart-rate")) {
    facts.push("Heart-rate summary is available.");
  }
  if (metrics.includes("steps")) {
    facts.push("Steps summary is available.");
  }
  if (facts.length === 0 && raws.length > 0) {
    facts.push("HealthKit reported a health summary.");
  }
  return facts;
}

function healthMetricTags(payload: Record<string, unknown>): string[] {
  const direct = typeof payload.metric === "string" ? [payload.metric] : [];
  const observations = Array.isArray(payload.observations)
    ? payload.observations
    : [];
  const fromObservations = observations.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const metric = (item as Record<string, unknown>).metric;
    return typeof metric === "string" ? [metric] : [];
  });
  return uniqueStrings([...direct, ...fromObservations].map((metric) => {
    if (metric === "heart_rate") return "heart-rate";
    return metric.split("_").join("-");
  }));
}

function uniqueSourceTypes(values: AmbientSourceType[]): AmbientSourceType[] {
  return Array.from(new Set(values));
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function numberPayload(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function todayLocalDate(): string {
  return localDateFromIso(new Date().toISOString());
}
