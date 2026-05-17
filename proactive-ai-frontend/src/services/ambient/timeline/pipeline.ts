import type { PersonalSignalInput } from "@/lib/devices";
import { candidateWindowToSignal, timelineEventToSignal, type AmbientWindowSourcePayload } from "./envelope";
import { ambientTimelineModels, type AmbientTimelineModelBridge, type AmbientTimelineEventDraft } from "./models";
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
  processPendingWindows(localDate?: string): Promise<PersonalSignalInput[]>;
}

export interface AmbientTimelinePipelineOptions {
  store?: AmbientTimelineStore;
  modelBridge?: AmbientTimelineModelBridge;
  now?: () => Date;
}

export class LocalAmbientTimelinePipeline implements AmbientTimelinePipeline {
  constructor(
    private store: AmbientTimelineStore = getAmbientTimelineStore(),
    private modelBridge: AmbientTimelineModelBridge = ambientTimelineModels,
    private options: { now?: () => Date } = {},
  ) {}

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
    out.push(...await this.processPendingWindows(localDate));
    return out;
  }

  async processPendingWindows(localDate = localDateFromDate(new Date())): Promise<PersonalSignalInput[]> {
    await this.store.init();
    const windows = await this.store.listCandidateWindows({
      localDate,
      windowType: "transcript_session",
      status: "pending",
      limit: 50,
    });
    const out: PersonalSignalInput[] = [];
    for (const window of windows) {
      if (window.generationPolicy !== "llm_allowed") continue;
      if (!this.isTranscriptWindowReady(window)) continue;
      if (!this.isBackoffExpired(window)) continue;
      const draft = await this.modelBridge.generateTimelineEvent(window);
      if (!draft) {
        await this.recordWindowAttempt(window, "model_unavailable");
        continue;
      }
      const event = makeEvent({
        id: stableId("evt", ["llm", window.id]),
        localDate: window.localDate,
        occurredAt: window.startedAt,
        endedAt: window.endedAt,
        eventType: draft.eventType,
        title: draft.title,
        summary: draft.summary,
        primarySourceLabel: window.deviceLabels[0] ?? sourceLabel("transcript"),
        deviceLabels: window.deviceLabels,
        sourceTypes: window.sourceTypes,
        tags: draft.tags,
        privacy: window.privacyHint,
        confidence: draft.confidence,
        confidenceLabel: draft.confidenceLabel,
        salience: window.salienceHint,
        rawRefs: window.rawRefs,
        windowId: window.id,
        generationMethod: "local_llm",
        dedupeKey: `ambient:timeline:${window.localDate}:llm:${stableHash(window.id)}`,
      });
      const signal = await this.upsertVisibleEvent(event);
      if (signal) out.push(signal);
      await this.store.upsertCandidateWindow({
        ...window,
        status: "generated",
        lastErrorCode: null,
        updatedAt: this.nowIso(),
      });
    }
    return out;
  }


  private isTranscriptWindowReady(window: AmbientCandidateWindow): boolean {
    const textLength = window.compactContext.trim().length;
    if (textLength < 80) return false;
    const startedAt = Date.parse(window.startedAt);
    const endedAt = Date.parse(window.endedAt ?? window.startedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return false;
    if (endedAt - startedAt < 30_000) return false;
    return this.now().getTime() - endedAt >= 60_000;
  }

  private isBackoffExpired(window: AmbientCandidateWindow): boolean {
    if (!window.lastAttemptAt || window.attemptCount <= 0) return true;
    const lastAttemptAt = Date.parse(window.lastAttemptAt);
    if (!Number.isFinite(lastAttemptAt)) return true;
    const cooldownMs = Math.min(30 * 60_000, 60_000 * (2 ** Math.max(0, window.attemptCount - 1)));
    return this.now().getTime() - lastAttemptAt >= cooldownMs;
  }

  private async recordWindowAttempt(
    window: AmbientCandidateWindow,
    errorCode: string,
  ): Promise<void> {
    await this.store.upsertCandidateWindow({
      ...window,
      lastAttemptAt: this.nowIso(),
      attemptCount: window.attemptCount + 1,
      lastErrorCode: errorCode,
      updatedAt: this.nowIso(),
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
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
      if (visit) {
        const visitWindow = await this.findWindow(
          raw.localDate,
          "visit_stay",
          stableId("win", ["visit_stay", raw.id]),
        );
        if (visitWindow) signals.push(visit, await this.candidateWindowSignal(visitWindow));
      }
      const transition = await this.generateTransition(raw);
      if (transition) {
        signals.push(transition);
        const transitionWindow = await this.latestWindow(raw.localDate, "transition");
        if (transitionWindow) signals.push(await this.candidateWindowSignal(transitionWindow));
      }
      return signals;
    }
    if (raw.sourceType === "location") {
      const window = await this.upsertLocationUpdateWindow(raw);
      if (window) signals.push(await this.candidateWindowSignal(window));
      return signals;
    }
    if (raw.sourceType === "transcript") {
      const window = await this.upsertTranscriptWindow(raw);
      if (window) signals.push(await this.candidateWindowSignal(window));
      return signals;
    }
    if (raw.sourceType === "sound") {
      if (raw.eventType === "sound.scene_run") {
        const window = await this.upsertSoundContextWindow(raw);
        signals.push(await this.candidateWindowSignal(window));
      }
      return signals;
    }
    if (raw.sourceType === "motion") {
      if (raw.eventType === "motion.segment") {
        const window = await this.upsertMotionStateWindow(raw);
        signals.push(await this.candidateWindowSignal(window));
      }
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
    const facts = healthFacts(raws);
    if (facts.length === 0) return null;
    const startedAt = healthEventTime(raws);
    if (!startedAt) return null;
    const refs = raws.map(rawRef);
    const compactContext = facts.join(" ");
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


  private async upsertLocationUpdateWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow | null> {
    const place = placeLabel(raw.payload);
    const locations = await this.store.listRawEvents({
      localDate: raw.localDate,
      sourceType: "location",
      limit: 200,
    });
    const earlier = locations
      .filter((candidate) => candidate.id !== raw.id
        && Date.parse(candidate.occurredAt) < Date.parse(raw.occurredAt))
      .reverse()
      .find((candidate) => candidate.eventType === "location.fix");
    if (earlier && !shouldUploadLocationUpdate(raw, earlier)) return null;
    const context = place ? `Location near ${place}.` : raw.compactText;
    return this.upsertWindow({
      id: stableId("win", ["location_update", raw.id]),
      localDate: raw.localDate,
      windowType: "location_update",
      startedAt: raw.occurredAt,
      endedAt: raw.endedAt,
      sourceTypes: ["location"],
      deviceLabels: ["iPhone"],
      rawRefs: [rawRef(raw)],
      compactContext: context,
      privacyHint: "private",
      confidenceHint: raw.confidence ?? 0.7,
      salienceHint: 0.35,
      generationPolicy: "do_not_generate",
      status: "evidence",
    });
  }

  private async upsertSoundContextWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow> {
    const startedAt = stringPayload(raw.payload, "started_at") ?? raw.occurredAt;
    const endedAt = stringPayload(raw.payload, "ended_at") ?? raw.endedAt;
    return this.upsertWindow({
      id: stableId("win", ["sound_context", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "sound_context",
      startedAt,
      endedAt,
      sourceTypes: ["sound"],
      deviceLabels: ["iPhone"],
      rawRefs: [rawRef(raw)],
      compactContext: soundContext(raw),
      privacyHint: "normal",
      confidenceHint: raw.confidence ?? 0.6,
      salienceHint: 0.25,
      generationPolicy: "do_not_generate",
      status: "evidence",
    });
  }

  private async upsertMotionStateWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow> {
    const startedAt = stringPayload(raw.payload, "started_at") ?? raw.occurredAt;
    const endedAt = stringPayload(raw.payload, "ended_at") ?? raw.endedAt;
    return this.upsertWindow({
      id: stableId("win", ["motion_state_run", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "motion_state_run",
      startedAt,
      endedAt,
      sourceTypes: ["motion"],
      deviceLabels: ["iPhone"],
      rawRefs: [rawRef(raw)],
      compactContext: motionContext(raw),
      privacyHint: "normal",
      confidenceHint: 0.65,
      salienceHint: 0.3,
      generationPolicy: "do_not_generate",
      status: "evidence",
    });
  }

  private async upsertTranscriptWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow | null> {
    const durationMs = numberPayload(raw.payload, "durationMs");
    const startedAt = raw.occurredAt;
    const endedAt = raw.endedAt
      ?? (durationMs
        ? new Date(Date.parse(startedAt) + durationMs).toISOString()
        : undefined);
    const sessionId = stringPayload(raw.payload, "captureSessionId") ?? raw.dedupeKey;
    const id = stableId("win", ["transcript_session", sessionId]);
    const existing = (await this.store.listCandidateWindows({
      localDate: raw.localDate,
      windowType: "transcript_session",
      limit: 200,
    })).find((window) => window.id === id);
    const existingRawRefIds = new Set((existing?.rawRefs ?? []).map((ref) => ref.id));
    const soundWindows = await this.overlappingSoundContextWindows(raw.localDate, startedAt, endedAt ?? startedAt);
    const newSoundWindows = soundWindows.filter((window) =>
      window.rawRefs.some((ref) => !existingRawRefIds.has(ref.id)),
    );
    const additions = [
      existingRawRefIds.has(raw.id) ? "" : raw.compactText,
      newSoundWindows.length > 0
        ? `Sound context: ${newSoundWindows.map((window) => window.compactContext).join(" ")}`
        : "",
    ].filter(Boolean);
    const soundContextText = additions.join(" ");
    const compactContext = existing?.compactContext
      ? [existing.compactContext, soundContextText].filter(Boolean).join(" ")
      : soundContextText || raw.compactText;
    const soundRawRefs = soundWindows.flatMap((window) => window.rawRefs);
    const nextHash = stableHash(compactContext);
    const inputChanged = existing?.llmInputHash !== undefined
      && existing.llmInputHash !== null
      && existing.llmInputHash !== nextHash;
    return this.upsertWindow({
      id,
      localDate: raw.localDate,
      windowType: "transcript_session",
      startedAt: earlierIso(existing?.startedAt, startedAt),
      endedAt: laterIso(existing?.endedAt, endedAt),
      sourceTypes: uniqueSourceTypes(["transcript", ...soundWindows.flatMap((window) => window.sourceTypes)]),
      deviceLabels: uniqueStrings(["Microphone", ...(soundWindows.length > 0 ? ["iPhone"] : [])]),
      rawRefs: uniqueRawRefs([...(existing?.rawRefs ?? []), rawRef(raw), ...soundRawRefs]),
      compactContext,
      privacyHint: "private",
      confidenceHint: 0.55,
      salienceHint: 0.5,
      generationPolicy: "llm_allowed",
      status: inputChanged ? "pending" : (existing?.status ?? "pending"),
      lastAttemptAt: inputChanged ? null : existing?.lastAttemptAt,
      attemptCount: inputChanged ? 0 : existing?.attemptCount,
      lastErrorCode: inputChanged ? null : existing?.lastErrorCode,
      llmInputHash: nextHash,
    });
  }


  private async overlappingSoundContextWindows(
    localDate: string,
    start: string,
    end: string,
  ): Promise<AmbientCandidateWindow[]> {
    const startTs = Date.parse(start);
    const endTs = Date.parse(end);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return [];
    const windows = await this.store.listCandidateWindows({
      localDate,
      windowType: "sound_context",
      status: "evidence",
      limit: 200,
    });
    return windows.filter((window) => {
      const windowStart = Date.parse(window.startedAt);
      const windowEnd = Date.parse(window.endedAt ?? window.startedAt);
      return Number.isFinite(windowStart)
        && Number.isFinite(windowEnd)
        && windowStart <= endTs
        && windowEnd >= startTs;
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
    const segmentMatches = motions.filter((raw) => {
      if (raw.eventType !== "motion.segment") return false;
      const segmentStart = Date.parse(stringPayload(raw.payload, "started_at") ?? raw.occurredAt);
      const segmentEnd = Date.parse(stringPayload(raw.payload, "ended_at") ?? raw.endedAt ?? raw.occurredAt);
      return Number.isFinite(segmentStart)
        && Number.isFinite(segmentEnd)
        && segmentStart <= endTs
        && segmentEnd >= startTs;
    });
    if (segmentMatches.length > 0) return segmentMatches;
    return motions.filter((raw) => {
      if (raw.eventType !== "motion.activity") return false;
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
    lastAttemptAt?: string | null;
    attemptCount?: number;
    lastErrorCode?: string | null;
  }): Promise<AmbientCandidateWindow> {
    const now = this.nowIso();
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
      lastAttemptAt: args.lastAttemptAt ?? null,
      attemptCount: args.attemptCount ?? 0,
      lastErrorCode: args.lastErrorCode ?? null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }


  private async findWindow(
    localDate: string,
    windowType: AmbientWindowType,
    id: string,
  ): Promise<AmbientCandidateWindow | null> {
    const windows = await this.store.listCandidateWindows({ localDate, windowType, limit: 200 });
    return windows.find((item) => item.id === id) ?? null;
  }

  private async latestWindow(
    localDate: string,
    windowType: AmbientWindowType,
  ): Promise<AmbientCandidateWindow | null> {
    const windows = await this.store.listCandidateWindows({ localDate, windowType, limit: 200 });
    return windows.length > 0 ? windows[windows.length - 1] ?? null : null;
  }

  private async candidateWindowSignal(window: AmbientCandidateWindow): Promise<PersonalSignalInput> {
    const sourcePayloads = await this.buildWindowUploadContext(window);
    const contextHash = stableHash(JSON.stringify({
      compactContext: window.compactContext,
      sourcePayloads,
    }));
    return candidateWindowToSignal(window, { sourcePayloads, contextHash });
  }

  private async buildWindowUploadContext(
    window: AmbientCandidateWindow,
  ): Promise<AmbientWindowSourcePayload[]> {
    const byRef = await this.store.getRawEventsByRefs(window.rawRefs);
    const effectiveEnd = window.endedAt ?? window.startedAt;
    const startMs = Date.parse(window.startedAt);
    const endMs = Date.parse(effectiveEnd);
    const nearbyStart = new Date(startMs - 10 * 60_000).toISOString();
    const nearbyEnd = new Date(endMs + 10 * 60_000).toISOString();
    const nearbyLocation = await this.store.listRawEventsInRange({
      localDate: window.localDate,
      sourceType: "location",
      start: nearbyStart,
      end: nearbyEnd,
      limit: 20,
    });
    const seen = new Set<string>();
    const out: AmbientWindowSourcePayload[] = [];
    for (const raw of byRef) {
      const payload = sanitizeRawPayload(raw);
      if (!payload) continue;
      seen.add(raw.id);
      out.push(sourcePayload(raw, "window_raw_ref", payload));
    }
    const locations = nearbyLocation
      .filter((raw) => !seen.has(raw.id))
      .sort(compareLocationContext)
      .slice(0, 2);
    for (const raw of locations) {
      const payload = sanitizeRawPayload(raw);
      if (!payload) continue;
      out.push(sourcePayload(raw, "nearby_context", payload));
    }
    return out.slice(0, 10);
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
  return new LocalAmbientTimelinePipeline(options.store, options.modelBridge, { now: options.now });
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
  confidenceLabel?: AmbientTimelineEvent["confidenceLabel"];
  salience: number;
  rawRefs: AmbientRawRef[];
  windowId?: string;
  generationMethod?: AmbientTimelineEvent["generationMethod"];
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
    confidenceLabel: args.confidenceLabel ?? (confidence >= 0.65 ? "certain" : "uncertain"),
    salience: clamp01(args.salience),
    rawRefs: uniqueRawRefs(args.rawRefs),
    observationIds: [],
    windowId: args.windowId,
    generationMethod: args.generationMethod ?? "rule",
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

const MIN_STEPS_FOR_VISIBLE_HEALTH = 100;
const MORNING_CUTOFF_HOUR = 12;

function healthFacts(raws: AmbientRawEvent[]): string[] {
  const facts: string[] = [];
  for (const observation of raws.flatMap((raw) => healthObservations(raw.payload))) {
    const metric = stringValue(observation.metric);
    const value = numberValue(observation.value);
    if (!metric || value === null) continue;
    if (metric === "sleep" && value > 0) {
      facts.push(`Slept ${Math.round(value)} min.`);
    } else if (metric === "heart_rate" && value > 0) {
      facts.push(`Average heart rate ${Math.round(value)} bpm over 6h.`);
    } else if (metric === "steps" && value >= MIN_STEPS_FOR_VISIBLE_HEALTH) {
      facts.push(`${Math.round(value)} steps today.`);
    }
  }
  return uniqueStrings(facts);
}

function healthEventTime(raws: AmbientRawEvent[]): string | null {
  const sleepRaw = raws.find((raw) => hasValidHealthObservation(raw.payload, "sleep"));
  if (sleepRaw) return sleepRaw.endedAt ?? sleepRaw.occurredAt;
  const heartRaw = raws.find((raw) => hasValidHealthObservation(raw.payload, "heart_rate"));
  if (heartRaw) return heartRaw.occurredAt;
  const stepsRaw = raws.find((raw) => hasValidHealthObservation(raw.payload, "steps"));
  if (!stepsRaw || !isBeforeLocalHour(stepsRaw.occurredAt, MORNING_CUTOFF_HOUR)) return null;
  return stepsRaw.occurredAt;
}

function hasValidHealthObservation(
  payload: Record<string, unknown>,
  metric: "sleep" | "heart_rate" | "steps",
): boolean {
  return healthObservations(payload).some((observation) => {
    if (stringValue(observation.metric) !== metric) return false;
    const value = numberValue(observation.value);
    if (value === null) return false;
    if (metric === "steps") return value >= MIN_STEPS_FOR_VISIBLE_HEALTH;
    return value > 0;
  });
}

function healthObservations(payload: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(payload.observations)
    ? payload.observations.filter((item): item is Record<string, unknown> => (
      item !== null && typeof item === "object"
    ))
    : [];
}

function isBeforeLocalHour(iso: string, hour: number): boolean {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.getHours() < hour;
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


function soundContext(raw: AmbientRawEvent): string {
  const label = stringPayload(raw.payload, "label") ?? "sound";
  const confidence = numberPayload(raw.payload, "maxConfidence") ?? raw.confidence;
  const confidenceText = confidence !== null ? `, max confidence ${Math.round(confidence * 100)}%` : "";
  return `Heard ${label} for ${formatDuration(numberPayload(raw.payload, "durationMs"))}${confidenceText}.`;
}

function motionContext(raw: AmbientRawEvent): string {
  const activity = stringPayload(raw.payload, "activity") ?? stringPayload(raw.payload, "type") ?? "activity";
  return `Motion ${activity} for ${formatDuration(numberPayload(raw.payload, "durationMs"))}.`;
}

function formatDuration(durationMs: number | null): string {
  if (!durationMs || durationMs <= 0) return "0s";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function stringPayload(payload: Record<string, unknown>, key: string): string | null {
  return stringValue(payload[key]);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function earlierIso(a: string | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}


function sourcePayload(
  raw: AmbientRawEvent,
  relation: AmbientWindowSourcePayload["relation"],
  payload: Record<string, unknown>,
): AmbientWindowSourcePayload {
  return {
    source_type: raw.sourceType,
    event_type: raw.eventType,
    occurred_at: raw.occurredAt,
    ...(raw.endedAt ? { ended_at: raw.endedAt } : {}),
    ...(raw.confidence !== null ? { confidence: raw.confidence } : {}),
    relation,
    payload,
  };
}

function sanitizeRawPayload(raw: AmbientRawEvent): Record<string, unknown> | null {
  switch (raw.sourceType) {
    case "transcript":
      return sanitizeTranscriptPayload(raw);
    case "location":
      return sanitizeLocationPayload(raw);
    case "visit":
      return sanitizeVisitPayload(raw);
    case "motion":
      return pick(raw.payload, [
        "activity", "started_at", "ended_at", "durationMs",
        "confidence", "maxConfidence", "sampleCount",
      ]);
    case "sound":
      return pick(raw.payload, [
        "label", "started_at", "ended_at", "durationMs",
        "maxConfidence", "sampleCount",
      ]);
    case "health":
      return pick(raw.payload, [
        "observations", "metric", "value", "unit", "local_date", "source_app",
      ]);
    case "calendar":
      return pick(raw.payload, ["title", "starts_at", "ends_at", "calendar_id"]);
  }
}

function sanitizeTranscriptPayload(raw: AmbientRawEvent): Record<string, unknown> {
  const payload = pick(raw.payload, [
    "durationMs", "provider", "language", "captureSessionId", "burstId",
  ]);
  const text = stringValue(raw.payload.text)
    ?? stringValue(raw.payload.transcript)
    ?? stringValue(raw.payload.signal_summary)
    ?? raw.compactText.replace(/^Transcript segment:\s*/, "");
  if (text) payload.text = text.slice(0, 8_000);
  return payload;
}

function sanitizeLocationPayload(raw: AmbientRawEvent): Record<string, unknown> {
  return pick(raw.payload, ["latitude", "longitude", "accuracy", "place"]);
}

function sanitizeVisitPayload(raw: AmbientRawEvent): Record<string, unknown> {
  return pick(raw.payload, [
    "kind", "place", "latitude", "longitude", "accuracy",
    "arrival_at", "departure_at",
  ]);
}

function pick(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function compareLocationContext(a: AmbientRawEvent, b: AmbientRawEvent): number {
  const aHasPlace = placeLabel(a.payload) ? 0 : 1;
  const bHasPlace = placeLabel(b.payload) ? 0 : 1;
  if (aHasPlace !== bHasPlace) return aHasPlace - bHasPlace;
  const aAcc = numberPayload(a.payload, "accuracy") ?? Number.POSITIVE_INFINITY;
  const bAcc = numberPayload(b.payload, "accuracy") ?? Number.POSITIVE_INFINITY;
  if (aAcc !== bAcc) return aAcc - bAcc;
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
}


function shouldUploadLocationUpdate(raw: AmbientRawEvent, previous: AmbientRawEvent): boolean {
  const rawPlace = placeLabel(raw.payload);
  const previousPlace = placeLabel(previous.payload);
  if (rawPlace && previousPlace && rawPlace !== previousPlace) return true;
  if (!previousPlace && rawPlace) return true;
  const rawLat = numberPayload(raw.payload, "latitude");
  const rawLng = numberPayload(raw.payload, "longitude");
  const prevLat = numberPayload(previous.payload, "latitude");
  const prevLng = numberPayload(previous.payload, "longitude");
  if (rawLat !== null && rawLng !== null && prevLat !== null && prevLng !== null) {
    if (distanceMeters(rawLat, rawLng, prevLat, prevLng) >= 150) return true;
  }
  return Date.parse(raw.occurredAt) - Date.parse(previous.occurredAt) >= 60 * 60_000;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earth = 6_371_000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}
