// Platform-free ambient timeline pipeline (lifted from web
// services/ambient/timeline/pipeline.ts). Raw-signal ingest, window building /
// dedupe, rule-based event generation and context snapshots — all pure data
// transforms. The store and the model bridge are injected dependencies. The
// app-side factories (createAmbientTimelinePipeline / getAmbientTimelinePipeline)
// stay in each app because they wire the Capacitor SQLite store and the native
// model bridge; they import this class and pass those in.
import type { PersonalSignalInput } from "../signals";
import { candidateWindowToSignal, timelineEventToSignal, type AmbientWindowSourcePayload } from "./envelope";
import {
  NoopAmbientTimelineModelBridge,
  type AmbientTimelineModelBridge,
} from "./pipeline-models";
import { rawEventFromSignal, placeLabel } from "./normalize";
import { normalizeSpeakerSegments, speakerAwareTranscriptTextFromPayload } from "./speaker-transcript";
import type {
  AmbientCandidateWindow,
  AmbientPrivacy,
  AmbientRawEvent,
  AmbientRawRef,
  AmbientSourceType,
  AmbientTimelineAction,
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
  stripTranscriptSegmentLabels,
  transcriptTextOnly,
  uniqueRawRefs,
  uniqueStrings,
} from "./utils";

export interface AmbientTimelineProcessOptions {
  force?: boolean;
  includeRecentPending?: boolean;
  forceReady?: boolean;
}

export interface AmbientTimelinePipeline {
  ingestSignal(item: PersonalSignalInput): Promise<PersonalSignalInput[]>;
  regenerateDay(localDate?: string, options?: AmbientTimelineProcessOptions): Promise<PersonalSignalInput[]>;
  processPendingWindows(localDate?: string, options?: AmbientTimelineProcessOptions): Promise<PersonalSignalInput[]>;
  generateContextSnapshot(now?: Date): Promise<PersonalSignalInput | null>;
}

export interface AmbientTimelinePipelineOptions {
  store?: AmbientTimelineStore;
  modelBridge?: AmbientTimelineModelBridge;
  now?: () => Date;
}

export class LocalAmbientTimelinePipeline implements AmbientTimelinePipeline {
  constructor(
    private store: AmbientTimelineStore,
    private modelBridge: AmbientTimelineModelBridge = new NoopAmbientTimelineModelBridge(),
    private options: { now?: () => Date } = {},
  ) {}

  async ingestSignal(item: PersonalSignalInput): Promise<PersonalSignalInput[]> {
    const raw = await this.store.upsertRawEvent(rawEventFromSignal(item));
    return this.generateForRaw(raw);
  }

  async regenerateDay(
    localDate = localDateFromDate(new Date()),
    options: AmbientTimelineProcessOptions = {},
  ): Promise<PersonalSignalInput[]> {
    await this.store.init();
    const raws = await this.store.listRawEvents({ localDate, limit: 1_000 });
    const out: PersonalSignalInput[] = [];
    for (const raw of raws) {
      out.push(...await this.generateForRaw(raw));
    }
    out.push(...await this.processPendingWindows(localDate, options));
    return out;
  }


  async generateContextSnapshot(now = this.now()): Promise<PersonalSignalInput | null> {
    await this.store.init();
    const endedAt = now.toISOString();
    const startedAt = new Date(now.getTime() - 15 * 60_000).toISOString();
    const localDate = localDateFromIso(endedAt);
    const sources: AmbientSourceType[] = [
      "calendar",
      "focus",
      "audio_route",
      "device_state",
      "motion",
      "location",
      "visit",
      "sound",
      "transcript",
    ];
    const raws = (await Promise.all(sources.map(async (sourceType) => this.store.listRawEventsInRange({
      localDate,
      sourceType,
      start: startedAt,
      end: endedAt,
      limit: 20,
    })))).flat();
    const sourcePayloads = raws
      .sort(compareNearbyContext)
      .slice(0, 12)
      .flatMap((raw) => {
        const payload = sanitizeRawPayload(raw);
        return payload ? [sourcePayload(raw, "nearby_context", payload)] : [];
      });
    if (sourcePayloads.length === 0) return null;
    const presentSources = uniqueSourceTypes(raws.map((raw) => raw.sourceType));
    const sourcePresence = sourcePresencePayload(presentSources);
    const compactContext = contextSnapshotText(sourcePayloads, sourcePresence);
    const window = await this.upsertWindow({
      id: stableId("win", ["context_snapshot", localDate, String(Math.floor(now.getTime() / (15 * 60_000)))]),
      localDate,
      windowType: "context_snapshot",
      startedAt,
      endedAt,
      sourceTypes: presentSources,
      deviceLabels: ["iPhone"],
      rawRefs: uniqueRawRefs(raws.map(rawRef)),
      compactContext,
      privacyHint: maxPrivacy(presentSources.map((source) => source === "device_state" ? "normal" : source === "motion" || source === "sound" ? "normal" : "private")),
      confidenceHint: 0.65,
      salienceHint: 0.45,
      generationPolicy: "do_not_generate",
      status: "evidence",
      llmInputHash: stableHash(JSON.stringify({ sourcePresence, sourcePayloads })),
    });
    return candidateWindowToSignal(window, {
      sourcePayloads,
      contextHash: stableHash(JSON.stringify({ compactContext, sourcePresence, sourcePayloads })),
    });
  }

  async processPendingWindows(
    localDate = localDateFromDate(new Date()),
    options: AmbientTimelineProcessOptions = {},
  ): Promise<PersonalSignalInput[]> {
    await this.store.init();
    const windows = await this.listPendingTranscriptWindows(localDate, options);
    const readyWindows = windows.filter((window) => window.generationPolicy === "llm_allowed"
      && (options.forceReady || this.isTranscriptWindowReady(window))
      && (options.force || this.isBackoffExpired(window)));
    const out: PersonalSignalInput[] = [];
    if (readyWindows.length === 0) return out;
    if (this.modelBridge.generateTimelineBatchDecision) {
      const selected = readyWindows.slice(0, 1);
      const result = await this.modelBridge.generateTimelineBatchDecision({ windows: selected });
      if (!result.ok) {
        for (const window of selected) await this.recordWindowAttempt(window, result.errorCode, result.errorMessage);
        return out;
      }
      for (const decision of result.batch.decisions) {
        if (decision.action === "skip") {
          for (const id of decision.sourceWindowIds) {
            const window = selected.find((item) => item.id === id);
            if (!window) continue;
            await this.store.upsertCandidateWindow({
              ...window,
              summaryStatus: "skipped_low_value",
              lastErrorCode: null,
              updatedAt: this.nowIso(),
            });
          }
          continue;
        }
        if (decision.action !== "create") continue;
        const decisionWindows = selected.filter((window) => decision.sourceWindowIds.includes(window.id));
        const first = decisionWindows[0];
        if (!first) continue;
        const sourceWindowIds = decisionWindows.map((window) => window.id);
        const event = makeEvent({
          id: stableId("evt", ["llm_summary", ...sourceWindowIds]),
          localDate: first.localDate,
          occurredAt: decision.occurredAt,
          endedAt: decisionWindows[decisionWindows.length - 1]?.endedAt,
          eventType: "conversation",
          title: decision.title,
          summary: decision.summary,
          primarySourceLabel: first.deviceLabels[0] ?? sourceLabel("transcript"),
          deviceLabels: decisionWindows.flatMap((window) => window.deviceLabels),
          sourceTypes: decisionWindows.flatMap((window) => window.sourceTypes),
          tags: ["ambient", "summary"],
          privacy: maxPrivacy(decisionWindows.map((window) => window.privacyHint)),
          confidence: average(decisionWindows.map((window) => window.confidenceHint)),
          confidenceLabel: "certain",
          salience: average(decisionWindows.map((window) => window.salienceHint)),
          rawRefs: decisionWindows.flatMap((window) => window.rawRefs),
          windowId: first.id,
          generationMethod: "local_llm",
          generationSource: "llm_summary",
          sourceWindowIds,
          idempotencyKey: `summary:create:${stableHash(sourceWindowIds.slice().sort().join("|"))}`,
          dedupeKey: `ambient:timeline:${first.localDate}:llm_summary:${stableHash(sourceWindowIds.slice().sort().join("|"))}`,
          actionCandidates: decision.actionCandidates,
        });
        const signal = await this.upsertVisibleEvent(event);
        if (signal) out.push(signal);
        for (const window of decisionWindows) {
          await this.store.upsertCandidateWindow({
            ...window,
            status: "generated",
            summaryStatus: "summarized",
            lastErrorCode: null,
            updatedAt: this.nowIso(),
          });
        }
      }
      return out;
    }
    for (const window of readyWindows) {
      const result = await this.modelBridge.generateTimelineEvent(window);
      if (!result.ok) {
        await this.recordWindowAttempt(window, result.errorCode, result.errorMessage);
        continue;
      }
      const draft = result.draft;
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
        generationSource: "llm_summary",
        sourceWindowIds: [window.id],
        dedupeKey: `ambient:timeline:${window.localDate}:llm:${stableHash(window.id)}`,
      });
      const signal = await this.upsertVisibleEvent(event);
      if (signal) out.push(signal);
      await this.store.upsertCandidateWindow({
        ...window,
        status: "generated",
        summaryStatus: "summarized",
        lastErrorCode: null,
        updatedAt: this.nowIso(),
      });
    }
    return out;
  }


  private async listPendingTranscriptWindows(
    localDate: string,
    options: AmbientTimelineProcessOptions,
  ): Promise<AmbientCandidateWindow[]> {
    const primary = await this.store.listCandidateWindows({
      localDate,
      windowType: "transcript_session",
      status: "pending",
      limit: 50,
    });
    if (!options.includeRecentPending || primary.length > 0) return primary;
    const recentDates = await this.recentLocalDatesWithPendingTranscriptWindows(localDate);
    const fallback: AmbientCandidateWindow[] = [];
    for (const date of recentDates) {
      fallback.push(...await this.store.listCandidateWindows({
        localDate: date,
        windowType: "transcript_session",
        status: "pending",
        limit: 10,
      }));
    }
    return fallback;
  }

  private async recentLocalDatesWithPendingTranscriptWindows(excludedLocalDate: string): Promise<string[]> {
    const raws = await this.store.listRawEvents({ limit: 1_000 });
    return uniqueStrings(raws
      .map((raw) => raw.localDate)
      .filter((date) => date !== excludedLocalDate))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 2);
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
    errorMessage?: string,
  ): Promise<void> {
    await this.store.upsertCandidateWindow({
      ...window,
      lastAttemptAt: this.nowIso(),
      attemptCount: window.attemptCount + 1,
      lastErrorCode: errorCode,
      summaryErrorCode: errorCode,
      summaryErrorMessage: errorMessage ?? null,
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
    if (raw.sourceType === "calendar") {
      const window = await this.upsertCalendarContextWindow(raw);
      signals.push(await this.candidateWindowSignal(window));
      return signals;
    }
    if (raw.sourceType === "focus") {
      const window = await this.upsertFocusContextWindow(raw);
      signals.push(await this.candidateWindowSignal(window));
      return signals;
    }
    if (raw.sourceType === "audio_route") {
      const window = await this.upsertAudioRouteContextWindow(raw);
      signals.push(await this.candidateWindowSignal(window));
      return signals;
    }
    if (raw.sourceType === "device_state") {
      const window = await this.upsertDeviceStateContextWindow(raw);
      if (window) signals.push(await this.candidateWindowSignal(window));
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
    const context = place ? `Location: ${place}.` : raw.compactText;
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

  private async upsertCalendarContextWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow> {
    const startedAt = stringPayload(raw.payload, "starts_at") ?? raw.occurredAt;
    const endedAt = stringPayload(raw.payload, "ends_at") ?? raw.endedAt;
    return this.upsertWindow({
      id: stableId("win", ["calendar_context", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "calendar_context",
      startedAt,
      endedAt,
      sourceTypes: ["calendar"],
      deviceLabels: ["Calendar"],
      rawRefs: [rawRef(raw)],
      compactContext: calendarContext(raw),
      privacyHint: "private",
      confidenceHint: 0.82,
      salienceHint: 0.5,
      generationPolicy: "do_not_generate",
      status: "evidence",
    });
  }

  private async upsertFocusContextWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow> {
    return this.upsertWindow({
      id: stableId("win", ["focus_context", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "focus_context",
      startedAt: raw.occurredAt,
      endedAt: raw.endedAt,
      sourceTypes: ["focus"],
      deviceLabels: ["iPhone"],
      rawRefs: [rawRef(raw)],
      compactContext: focusContext(raw),
      privacyHint: "private",
      confidenceHint: 0.7,
      salienceHint: 0.35,
      generationPolicy: "do_not_generate",
      status: "evidence",
    });
  }

  private async upsertAudioRouteContextWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow> {
    return this.upsertWindow({
      id: stableId("win", ["audio_route_context", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "audio_route_context",
      startedAt: raw.occurredAt,
      endedAt: raw.endedAt,
      sourceTypes: ["audio_route"],
      deviceLabels: ["iPhone"],
      rawRefs: [rawRef(raw)],
      compactContext: audioRouteContext(raw),
      privacyHint: "private",
      confidenceHint: 0.72,
      salienceHint: 0.45,
      generationPolicy: "do_not_generate",
      status: "evidence",
    });
  }

  private async upsertDeviceStateContextWindow(raw: AmbientRawEvent): Promise<AmbientCandidateWindow | null> {
    if (!isDeviceCollectionConstrained(raw)) return null;
    return this.upsertWindow({
      id: stableId("win", ["device_state_context", raw.dedupeKey]),
      localDate: raw.localDate,
      windowType: "device_state_context",
      startedAt: raw.occurredAt,
      endedAt: raw.endedAt,
      sourceTypes: ["device_state"],
      deviceLabels: ["iPhone"],
      rawRefs: [rawRef(raw)],
      compactContext: deviceStateContext(raw),
      privacyHint: "normal",
      confidenceHint: 0.8,
      salienceHint: 0.55,
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
    const windowStartedAt = startedAt;
    const windowEndedAt = endedAt ?? startedAt;
    const soundWindows = await this.overlappingSoundContextWindows(raw.localDate, windowStartedAt, windowEndedAt);
    const locationWindows = await this.overlappingLocationUpdateWindows(raw.localDate, windowStartedAt, windowEndedAt);
    const motionWindows = await this.overlappingMotionStateRunWindows(raw.localDate, windowStartedAt, windowEndedAt);
    const visitWindows = await this.overlappingVisitStayWindows(raw.localDate, windowStartedAt, windowEndedAt);
    const calendarWindows = await this.overlappingContextWindows(raw.localDate, "calendar_context", windowStartedAt, windowEndedAt);
    const focusWindows = await this.overlappingContextWindows(raw.localDate, "focus_context", windowStartedAt, windowEndedAt);
    const audioRouteWindows = await this.overlappingContextWindows(raw.localDate, "audio_route_context", windowStartedAt, windowEndedAt);
    const deviceStateWindows = await this.overlappingContextWindows(raw.localDate, "device_state_context", windowStartedAt, windowEndedAt);
    const hasNewRefs = (windows: AmbientCandidateWindow[]) =>
      windows.filter((window) => window.rawRefs.some((ref) => !existingRawRefIds.has(ref.id)));
    const newSoundWindows = hasNewRefs(soundWindows);
    const newLocationWindows = hasNewRefs(locationWindows);
    const newMotionWindows = hasNewRefs(motionWindows);
    const newVisitWindows = hasNewRefs(visitWindows);
    const newCalendarWindows = hasNewRefs(calendarWindows);
    const newFocusWindows = hasNewRefs(focusWindows);
    const newAudioRouteWindows = hasNewRefs(audioRouteWindows);
    const newDeviceStateWindows = hasNewRefs(deviceStateWindows);
    const joinContext = (windows: AmbientCandidateWindow[]) =>
      windows.map((window) => window.compactContext).filter(Boolean).join(" ");
    const transcriptText = speakerAwareTranscriptTextFromPayload(
      raw.payload,
      stripTranscriptSegmentLabels(raw.compactText),
    );
    const additions = [
      existingRawRefIds.has(raw.id) ? "" : transcriptText,
      newSoundWindows.length > 0 ? `Sound context: ${joinContext(newSoundWindows)}` : "",
      newLocationWindows.length > 0 ? `Location context: ${joinContext(newLocationWindows)}` : "",
      newMotionWindows.length > 0 ? `Motion context: ${joinContext(newMotionWindows)}` : "",
      newVisitWindows.length > 0 ? `Place context: ${joinContext(newVisitWindows)}` : "",
      newCalendarWindows.length > 0 ? `Calendar context: ${joinContext(newCalendarWindows)}` : "",
      newFocusWindows.length > 0 ? `Focus context: ${joinContext(newFocusWindows)}` : "",
      newAudioRouteWindows.length > 0 ? `Audio route context: ${joinContext(newAudioRouteWindows)}` : "",
      newDeviceStateWindows.length > 0 ? `Device context: ${joinContext(newDeviceStateWindows)}` : "",
    ].filter(Boolean);
    const additionsText = additions.join(" ");
    const compactContext = existing?.compactContext
      ? transcriptTextOnly([transcriptTextOnly(existing.compactContext), additionsText].filter(Boolean).join("\n"))
      : additionsText || transcriptText;
    const evidenceWindows = [
      ...soundWindows,
      ...locationWindows,
      ...motionWindows,
      ...visitWindows,
      ...calendarWindows,
      ...focusWindows,
      ...audioRouteWindows,
      ...deviceStateWindows,
    ];
    const evidenceRawRefs = evidenceWindows.flatMap((window) => window.rawRefs);
    const evidenceSourceTypes = evidenceWindows.flatMap((window) => window.sourceTypes);
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
      sourceTypes: uniqueSourceTypes(["transcript", ...evidenceSourceTypes]),
      deviceLabels: uniqueStrings(["Microphone", ...(evidenceWindows.length > 0 ? ["iPhone"] : [])]),
      rawRefs: uniqueRawRefs([...(existing?.rawRefs ?? []), rawRef(raw), ...evidenceRawRefs]),
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
    return this.overlappingContextWindows(localDate, "sound_context", start, end);
  }

  private async overlappingLocationUpdateWindows(
    localDate: string,
    start: string,
    end: string,
  ): Promise<AmbientCandidateWindow[]> {
    return this.overlappingContextWindows(localDate, "location_update", start, end);
  }

  private async overlappingMotionStateRunWindows(
    localDate: string,
    start: string,
    end: string,
  ): Promise<AmbientCandidateWindow[]> {
    return this.overlappingContextWindows(localDate, "motion_state_run", start, end);
  }

  private async overlappingVisitStayWindows(
    localDate: string,
    start: string,
    end: string,
  ): Promise<AmbientCandidateWindow[]> {
    return this.overlappingContextWindows(localDate, "visit_stay", start, end);
  }

  private async overlappingContextWindows(
    localDate: string,
    windowType: AmbientWindowType,
    start: string,
    end: string,
  ): Promise<AmbientCandidateWindow[]> {
    const startTs = Date.parse(start);
    const endTs = Date.parse(end);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return [];
    const windows = await this.store.listCandidateWindows({
      localDate,
      windowType,
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
    const nearbyBySource = await Promise.all(([
      "location",
      "calendar",
      "focus",
      "audio_route",
      "device_state",
      "motion",
      "sound",
      "visit",
    ] as AmbientSourceType[]).map(async (sourceType) => this.store.listRawEventsInRange({
      localDate: window.localDate,
      sourceType,
      start: nearbyStart,
      end: nearbyEnd,
      limit: 20,
    })));
    const seen = new Set<string>();
    const out: AmbientWindowSourcePayload[] = [];
    for (const raw of byRef) {
      const payload = sanitizeRawPayload(raw);
      if (!payload) continue;
      seen.add(raw.id);
      out.push(sourcePayload(raw, "window_raw_ref", payload));
    }
    const nearby = nearbyBySource
      .flat()
      .filter((raw) => !seen.has(raw.id))
      .sort(compareNearbyContext)
      .slice(0, 8);
    for (const raw of nearby) {
      const payload = sanitizeRawPayload(raw);
      if (!payload) continue;
      seen.add(raw.id);
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
  generationSource?: AmbientTimelineEvent["generationSource"];
  sourceWindowIds?: string[];
  idempotencyKey?: string;
  actionCandidates?: AmbientTimelineAction[];
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
    generationSource: args.generationSource ?? (args.generationMethod === "local_llm" ? "llm_summary" : "rule_based"),
    sourceWindowIds: args.sourceWindowIds ?? [],
    idempotencyKey: args.idempotencyKey,
    ...(args.actionCandidates && args.actionCandidates.length > 0
      ? { actionCandidates: args.actionCandidates.map(cloneAction) }
      : {}),
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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return clamp01(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function rawRef(raw: AmbientRawEvent): AmbientRawRef {
  return { sourceType: raw.sourceType, id: raw.id };
}

function cloneAction(action: AmbientTimelineAction): AmbientTimelineAction {
  return {
    label: action.label,
    goal: action.goal,
    ...(action.goalBasket ? { goalBasket: action.goalBasket } : {}),
  };
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
  const label = stringPayload(raw.payload, "displayLabel")
    ?? stringPayload(raw.payload, "primaryLabel")
    ?? stringPayload(raw.payload, "label")
    ?? "sound";
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
        "label", "primaryLabel", "displayLabel", "started_at", "ended_at", "durationMs",
        "maxConfidence", "sourceConfidence", "sampleCount", "topCandidates",
      ]);
    case "health":
      return pick(raw.payload, [
        "observations", "metric", "value", "unit", "local_date", "source_app",
      ]);
    case "calendar":
      return pick(raw.payload, [
        "schema_version", "title", "starts_at", "ends_at", "attendee_count",
        "attendees", "calendar", "calendar_id", "location", "notes", "availability",
        "is_all_day", "observed_at",
      ]);
    case "focus":
      return pick(raw.payload, ["schema_version", "focused", "focus_label", "authorization_state", "observed_at"]);
    case "audio_route":
      return pick(raw.payload, [
        "schema_version", "route_inputs", "route_outputs", "has_car_audio",
        "has_bluetooth_a2dp", "has_bluetooth_hfp", "engine_state",
        "suppressed", "suppressed_reason", "observed_at",
      ]);
    case "device_state":
      return pick(raw.payload, [
        "schema_version", "thermal", "low_power", "battery_pct", "charging",
        "reason", "observed_at",
      ]);
  }
}

function sanitizeTranscriptPayload(raw: AmbientRawEvent): Record<string, unknown> {
  const payload = pick(raw.payload, [
    "durationMs", "provider", "language", "captureSessionId", "burstId",
    "speaker_labels", "self_text", "diarization_model", "diarization_status",
  ]);
  const speakerSegments = normalizeSpeakerSegments(raw.payload.speaker_segments);
  if (speakerSegments.length > 0) payload.speaker_segments = speakerSegments;
  const speakerText = speakerAwareTranscriptTextFromPayload(raw.payload, "");
  if (speakerText) payload.speaker_text = speakerText;
  const text = stringValue(raw.payload.text)
    ?? stringValue(raw.payload.transcript)
    ?? stringValue(raw.payload.signal_summary)
    ?? raw.compactText.replace(/^Transcript segment:\s*/, "");
  if (text) payload.text = text.slice(0, 8_000);
  return payload;
}

function sanitizeLocationPayload(raw: AmbientRawEvent): Record<string, unknown> {
  const payload = pick(raw.payload, [
    "latitude", "longitude", "accuracy", "location_fix",
    "place_candidates", "display_place", "place_resolution",
  ]);
  const candidates = Array.isArray(payload.place_candidates) ? payload.place_candidates.slice(0, 5) : undefined;
  if (candidates) payload.place_candidates = candidates;
  return withPoi(raw.payload, payload);
}

function sanitizeVisitPayload(raw: AmbientRawEvent): Record<string, unknown> {
  return withPoi(raw.payload, pick(raw.payload, [
    "kind", "latitude", "longitude", "accuracy",
    "arrival_at", "departure_at",
  ]));
}

function withPoi(
  rawPayload: Record<string, unknown>,
  sanitized: Record<string, unknown>,
): Record<string, unknown> {
  const poi = normalizePoi(rawPayload);
  return poi ? { ...sanitized, place: poi, poi } : sanitized;
}

function normalizePoi(payload: Record<string, unknown>): Record<string, unknown> | null {
  const place = payload.place;
  if (!place || typeof place !== "object") return null;
  const row = place as Record<string, unknown>;
  const poi = pickText(row, [
    "label", "place_name", "address", "poi_name", "poi_category",
    "area_of_interest", "thoroughfare", "sub_thoroughfare",
    "locality", "sub_locality", "administrative_area",
    "postal_code", "country", "country_code", "source",
  ]);
  const distance = numberValue(row.poi_distance_m);
  if (distance !== null) poi.poi_distance_m = distance;
  const areas = stringArray(row.areas_of_interest).slice(0, 5);
  if (areas.length > 0) poi.areas_of_interest = areas;
  return Object.keys(poi).length > 0 ? poi : null;
}

function pickText(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = stringValue(payload[key]);
    if (value) out[key] = value.slice(0, 512);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}

function pick(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}



function sourcePresencePayload(presentSources: AmbientSourceType[]): Record<string, string> {
  const present = new Set(presentSources);
  return {
    microphone: present.has("transcript") || present.has("sound") ? "granted" : "unknown",
    transcript: present.has("transcript") ? "present" : "not_observed",
    sound: present.has("sound") ? "present" : "missing",
    calendar: present.has("calendar") ? "present" : "missing",
    focus: present.has("focus") ? "present" : "missing",
    audio_route: present.has("audio_route") ? "present" : "missing",
    motion: present.has("motion") ? "present" : "missing",
    location: present.has("location") || present.has("visit") ? "present" : "missing",
    device_state: present.has("device_state") ? "present" : "missing",
  };
}

function contextSnapshotText(
  sourcePayloads: AmbientWindowSourcePayload[],
  sourcePresence: Record<string, string>,
): string {
  const sources = uniqueStrings(sourcePayloads.map((payload) => payload.source_type));
  const mic = sourcePresence.microphone === "unknown" ? "microphone state unknown" : `microphone ${sourcePresence.microphone}`;
  return `Context snapshot: ${sources.join(", ")} observed; ${mic}; transcript ${sourcePresence.transcript}.`;
}

function calendarContext(raw: AmbientRawEvent): string {
  const title = stringPayload(raw.payload, "title") ?? "Calendar event";
  const starts = stringPayload(raw.payload, "starts_at") ?? raw.occurredAt;
  const ends = stringPayload(raw.payload, "ends_at");
  const attendees = numberPayload(raw.payload, "attendee_count");
  return `Calendar shows "${title}" from ${formatTime(starts)}${ends ? ` to ${formatTime(ends)}` : ""}${attendees !== null ? ` with ${attendees} attendees` : ""}.`;
}

function focusContext(raw: AmbientRawEvent): string {
  const focused = raw.payload.focused === true;
  return focused ? "Focus mode active." : "Focus mode inactive.";
}

function audioRouteContext(raw: AmbientRawEvent): string {
  if (raw.payload.has_car_audio === true) return "Audio route indicates CarPlay or car audio.";
  if (raw.payload.has_bluetooth_a2dp === true || raw.payload.has_bluetooth_hfp === true) {
    return "Audio route indicates Bluetooth audio.";
  }
  return raw.compactText;
}

function deviceStateContext(raw: AmbientRawEvent): string {
  const reason = stringPayload(raw.payload, "reason");
  if (reason === "low_power") return "Device collection constrained: Low Power Mode enabled.";
  if (reason === "thermal") return `Device collection constrained: thermal state ${stringPayload(raw.payload, "thermal") ?? "unknown"}.`;
  if (reason === "low_battery") return `Device collection constrained: low battery ${numberPayload(raw.payload, "battery_pct") ?? "unknown"}%.`;
  return raw.compactText;
}

function isDeviceCollectionConstrained(raw: AmbientRawEvent): boolean {
  const reason = stringPayload(raw.payload, "reason");
  return reason === "low_power" || reason === "thermal" || reason === "low_battery";
}

function compareNearbyContext(a: AmbientRawEvent, b: AmbientRawEvent): number {
  const priority = (raw: AmbientRawEvent) => {
    if (raw.sourceType === "calendar") return 0;
    if (raw.sourceType === "audio_route") return 1;
    if (raw.sourceType === "focus") return 2;
    if (raw.sourceType === "device_state") return 3;
    if (raw.sourceType === "location") return 4;
    if (raw.sourceType === "visit") return 5;
    if (raw.sourceType === "motion") return 6;
    if (raw.sourceType === "sound") return 7;
    return 8;
  };
  const diff = priority(a) - priority(b);
  if (diff !== 0) return diff;
  if (a.sourceType === "location" && b.sourceType === "location") return compareLocationContext(a, b);
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
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
