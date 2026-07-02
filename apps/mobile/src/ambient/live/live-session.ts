/**
 * RN live-session —— dev proactive-ai-frontend/src/services/ambient/live-session.ts 的移植版。
 * 纯逻辑（类型 + transcript/context → LiveSession transform）。按 RN 惯例适配：文案照 dev 走
 * i18n.t（key/ns 与 dev 一致，指向 RN i18n 入口）、lucide-react → lucide-react-native、去掉
 * Capacitor 的 appendTranscript + web-only demoLiveScenarios。逻辑与 dev 完全一致。
 */
import { speakerAwareTranscriptTextFromPayload } from "@pin-ai/core";
import type { AmbientCandidateWindow, AmbientPrivacy, AmbientRawEvent } from "@pin-ai/core";
import {
  Activity,
  MapPin,
  Mic,
  Radio,
  Stethoscope,
  type LucideIcon,
} from "lucide-react-native";

import i18n from "../../i18n";

export interface LiveAssistItem {
  time: string;
  sortTs?: number;
  kind: "context" | "assist" | "action";
  text: string;
  source?: string;
}

export interface LiveSession {
  icon: LucideIcon;
  kind: string;
  title: string;
  location: string;
  device: string;
  startedAt: string;
  signals: string[];
  assists: LiveAssistItem[];
}

interface LiveAssistMessage {
  id: string;
  time: string;
  sortTs?: number;
  text: string;
  source?: string;
}

export interface LiveSessionData {
  captureSessionId: string;
  startedAt: number;
  messages: LiveAssistMessage[];
}

export interface LiveHistoryTranscript {
  id: string;
  captureSessionId: string;
  occurredAt: string;
  text: string;
  source?: string;
}

export interface AmbientLiveSessionState {
  current: LiveSessionData | null;
  history: LiveHistoryTranscript[];
  contextItems: LiveSessionContextItem[];
}

export interface LiveTranscriptUpdate {
  captureSessionId: string;
  id: string;
  text: string;
  source?: string;
  receivedAt?: number;
}

const MAX_LIVE_MESSAGES = 30;
const CURRENT_LIVE_FRESHNESS_MS = 120_000;
const LIVE_SESSION_TITLE_MAX = 64;
const MAX_HISTORY_TRANSCRIPTS = 5;
const MAX_REPLAY_TRANSCRIPTS = 10_000;
const MAX_CONTEXT_WINDOWS = 8;
const MAX_SESSION_SIGNALS = 5;
const MAX_CONTEXT_ASSISTS = 8;
const RECENT_CONTEXT_WINDOW_MS = 30 * 60 * 1000;
const HIDDEN_LIVE_TRANSCRIPT_TEXTS = new Set([
  "transcription unavailable",
  "transcription failed",
  "transcription error",
  "audio unavailable",
  "speech recognition unavailable",
]);

export type LiveSessionContextKind =
  | "place"
  | "visit"
  | "health"
  | "motion"
  | "sound"
  | "calendar"
  | "transcript"
  | "transition";

export interface LiveSessionContextItem {
  id: string;
  kind: LiveSessionContextKind;
  /** Localized display label — never branch logic on it (use `kind`/`placeName`). */
  label: string;
  /** Raw place name parsed from native English compactText (data, not copy).
   *  Set for place/visit items so titles can be rebuilt without parsing `label`. */
  placeName?: string;
  summary?: string;
  transcriptText?: () => string | null;
  startedAt: string;
  endedAt?: string;
  privacy: AmbientPrivacy;
  confidenceLabel?: "certain" | "uncertain";
  sourceWindowIds: string[];
}

interface ContextBuildOptions {
  now?: Date;
  maxWindows?: number;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `+${m}:${s}`;
}

export function formatStartTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function appendLiveTranscript(
  prev: LiveSessionData | null,
  update: LiveTranscriptUpdate,
): LiveSessionData {
  const text = update.text.trim();
  const receivedAt = update.receivedAt ?? Date.now();
  if (isHiddenLiveTranscriptText(text)) {
    return prev ?? emptyLiveSessionData(update.captureSessionId, receivedAt);
  }
  if (!isFreshLiveTimestamp(receivedAt)) {
    return prev ?? emptyLiveSessionData(update.captureSessionId, receivedAt);
  }
  const isNewSession = !prev || prev.captureSessionId !== update.captureSessionId;
  const startedAt = isNewSession ? receivedAt : prev.startedAt;
  const message: LiveAssistMessage = {
    id: update.id,
    time: formatStartTimestamp(receivedAt),
    sortTs: receivedAt,
    text,
    source: update.source,
  };
  const messages = upsertLiveMessage(isNewSession ? [] : prev.messages, message)
    .slice(-MAX_LIVE_MESSAGES);
  return {
    captureSessionId: update.captureSessionId,
    startedAt,
    messages,
  };
}

function upsertLiveMessage(
  messages: LiveAssistMessage[],
  next: LiveAssistMessage,
): LiveAssistMessage[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index >= 0) {
    return messages.map((message, i) => i === index ? next : message);
  }
  const withoutListening = messages.filter((message) => message.id !== "listening");
  return [...withoutListening, next];
}

function dedupeLiveMessages(messages: LiveAssistMessage[]): LiveAssistMessage[] {
  const byId = new Map<string, LiveAssistMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return Array.from(byId.values())
    .sort((a, b) => (a.sortTs ?? 0) - (b.sortTs ?? 0));
}

function emptyLiveSessionData(captureSessionId: string, startedAt: number): LiveSessionData {
  return {
    captureSessionId,
    startedAt,
    messages: [],
  };
}

function isHiddenLiveTranscriptText(text: string): boolean {
  const normalized = text.trim().replace(/[.]$/, "").toLowerCase();
  return HIDDEN_LIVE_TRANSCRIPT_TEXTS.has(normalized);
}

export function rawTranscriptEventsToLiveSessionData(
  events: AmbientRawEvent[],
  maxItems = MAX_REPLAY_TRANSCRIPTS,
): LiveSessionData | null {
  const messages = events
    .filter((event) => event.sourceType === "transcript")
    .filter((event) => event.eventType === "transcript.ready")
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .flatMap((event) => {
      const text = transcriptTextFromRaw(event);
      const sortTs = Date.parse(event.occurredAt);
      if (!text || !Number.isFinite(sortTs)) return [];
      return [{
        id: transcriptBurstId(event) ?? event.id,
        time: formatStartTimestamp(sortTs),
        sortTs,
        text,
        source: transcriptProvider(event),
      }];
    });
  const deduped = dedupeLiveMessages(messages).slice(-maxItems);
  if (deduped.length === 0) return null;
  const first = deduped[0];
  const localDate = events.find((event) => event.localDate)?.localDate ?? "unknown";
  return {
    captureSessionId: `ambient-live-replay:${localDate}`,
    startedAt: first.sortTs ?? Date.now(),
    messages: deduped,
  };
}

export function rawTranscriptEventsToHistory(
  events: AmbientRawEvent[],
  maxItems = MAX_HISTORY_TRANSCRIPTS,
): LiveHistoryTranscript[] {
  const transcripts = events
    .filter((event) => event.sourceType === "transcript")
    .filter((event) => event.eventType === "transcript.ready")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

  return transcripts
    .flatMap((event) => {
      const item = rawTranscriptEventToHistory(event);
      return item ? [item] : [];
    })
    .slice(0, maxItems);
}

export function liveSessionDataToSession(
  ambientOn: boolean,
  data: LiveSessionData | null,
  contextItems: LiveSessionContextItem[] = [],
): LiveSession | null {
  if (!ambientOn) return null;
  const hasTranscript = !!data && data.messages.length > 0;
  const visibleContext = contextItems
    .filter((item) => item.kind !== "transcript")
    .slice(0, MAX_CONTEXT_ASSISTS);
  if (!hasTranscript && visibleContext.length === 0) return null;
  const transcriptMessages = data?.messages ?? [];
  const hasDisplayTranscript = transcriptMessages.length > 0;
  const displayContext = hasDisplayTranscript
    ? visibleContext.filter((item) => item.kind !== "transcript")
    : visibleContext;
  const last = hasDisplayTranscript ? transcriptMessages[transcriptMessages.length - 1] : null;
  const title = last
    ? truncateTitle(last.text) || i18n.t("ambient:live.transcriptTitle")
    : contextOnlyTitle(displayContext);
  const provider = last?.source ?? "device";
  const primaryPlace = displayContext.find((item) => item.kind === "place" || item.kind === "visit");
  const location = primaryPlace?.label
    ?? (hasDisplayTranscript
      ? i18n.t("ambient:live.onDeviceCaptured")
      : i18n.t("ambient:live.ambientContextActive"));
  const device = uniqueStrings([
    ...(hasDisplayTranscript ? [i18n.t("ambient:rawEvent.microphone")] : []),
    ...deviceLabelsForContext(displayContext),
  ]).join(" · ") || i18n.t("ambient:liveCard.standbyDevice");
  const startedAt = data
    ? formatStartTimestamp(data.startedAt)
    : formatStartTimestamp(Date.parse(displayContext[displayContext.length - 1]?.startedAt ?? new Date().toISOString()));

  return {
    icon: hasDisplayTranscript ? Mic : iconForContext(displayContext),
    kind: hasDisplayTranscript
      ? i18n.t("ambient:live.kindVoiceSession")
      : i18n.t("ambient:live.kindAmbientContext"),
    title,
    location,
    device,
    startedAt,
    signals: sessionSignals(transcriptMessages.length, displayContext, provider),
    assists: sortLiveAssists([
      ...displayContext.map(contextItemToAssist),
      ...transcriptMessages.map((m) => ({
        time: m.time,
        sortTs: m.sortTs ?? timestampFromDisplayTime(m.time, data?.startedAt),
        kind: "context" as const,
        text: m.text,
        source: m.source,
      })),
    ]),
  };
}

export function candidateWindowsToLiveSessionContextItems(
  windows: AmbientCandidateWindow[],
  options: ContextBuildOptions = {},
): LiveSessionContextItem[] {
  const now = options.now ?? new Date();
  return windows
    .filter(isDisplayableWindow)
    .filter((window) => isRecentWindow(window, now))
    .sort(compareWindowRecencyDesc)
    .slice(0, options.maxWindows ?? MAX_CONTEXT_WINDOWS)
    .flatMap((window) => {
      const item = candidateWindowToLiveSessionItem(window);
      return item ? [item] : [];
    });
}

export function rawEventsToLiveSessionContextItems(
  events: AmbientRawEvent[],
  options: ContextBuildOptions = {},
): LiveSessionContextItem[] {
  const now = options.now ?? new Date();
  return latestRawEventsBySource(events)
    .filter((event) => isRecentRawEvent(event, now))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, options.maxWindows ?? MAX_CONTEXT_WINDOWS)
    .flatMap((event) => {
      const item = rawEventToLiveSessionItem(event);
      return item ? [item] : [];
    });
}



function rawTranscriptEventToHistory(event: AmbientRawEvent): LiveHistoryTranscript | null {
  const text = transcriptTextFromRaw(event);
  if (!text) return null;
  return {
    id: transcriptBurstId(event) ?? event.id,
    captureSessionId: transcriptCaptureSessionId(event),
    occurredAt: event.occurredAt,
    text,
    source: transcriptProvider(event),
  };
}

function transcriptTextFromRaw(event: AmbientRawEvent): string | null {
  const speakerText = speakerAwareTranscriptTextFromPayload(event.payload, "");
  if (speakerText) return speakerText;
  const payloadText = event.payload.text;
  if (typeof payloadText === "string" && payloadText.trim()) {
    const text = payloadText.trim();
    return isHiddenLiveTranscriptText(text) ? null : text;
  }
  const compact = event.compactText.trim();
  const prefix = "Transcript segment:";
  const text = compact.startsWith(prefix)
    ? compact.slice(prefix.length).trim() || null
    : compact || null;
  return text && isHiddenLiveTranscriptText(text) ? null : text;
}

function transcriptTextFromCandidateWindow(window: AmbientCandidateWindow): string | null {
  const segments = window.compactContext
    .split(/Transcript segment:\s*/g)
    .map((part) => part.replace(/^Sound context:\s*/i, "").trim())
    .filter(Boolean);
  const unique: string[] = [];
  for (const segment of segments) {
    if (unique[unique.length - 1] !== segment) unique.push(segment);
  }
  const text = unique.join(" ").trim();
  return text || null;
}

function transcriptCaptureSessionId(event: AmbientRawEvent): string {
  const value = event.payload.captureSessionId;
  return typeof value === "string" && value.trim() ? value : event.id;
}

function transcriptBurstId(event: AmbientRawEvent): string | null {
  const value = event.payload.burstId;
  return typeof value === "string" && value.trim() ? value : null;
}

function transcriptProvider(event: AmbientRawEvent): string | undefined {
  const value = event.payload.provider;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function candidateWindowToLiveSessionItem(
  window: AmbientCandidateWindow,
): LiveSessionContextItem | null {
  const base = {
    id: `live-window-${window.id}`,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
    privacy: window.privacyHint,
    confidenceLabel: window.confidenceHint >= 0.65 ? "certain" as const : "uncertain" as const,
    sourceWindowIds: [window.id],
  };
  if (window.windowType === "location_update") {
    const place = placeLabelFromWindow(window);
    const label = locationDisplayLabel(place);
    return {
      ...base,
      kind: "place",
      label,
      ...(place ? { placeName: placeNameFromData(place) } : {}),
      summary: privacySuffix(label, window.privacyHint),
    };
  }
  if (window.windowType === "visit_stay") {
    const place = placeLabelFromWindow(window);
    const label = place ? nearPlaceLabel(place) : i18n.t("ambient:live.visitContextActive");
    return {
      ...base,
      kind: "visit",
      label,
      ...(place ? { placeName: placeNameFromData(place) } : {}),
      summary: privacySuffix(label, window.privacyHint),
    };
  }
  if (window.windowType === "motion_state_run") {
    const label = motionLabel(window.compactContext);
    return { ...base, kind: "motion", label, summary: privacySuffix(label, window.privacyHint) };
  }
  if (window.windowType === "sound_context") {
    const label = soundLabel(window.compactContext);
    return { ...base, kind: "sound", label, summary: privacySuffix(label, window.privacyHint) };
  }
  if (window.windowType === "transcript_session") {
    const label = i18n.t("ambient:live.conversationWindowActive");
    return {
      ...base,
      kind: "transcript",
      label,
      summary: privacySuffix(label, window.privacyHint),
      transcriptText: () => transcriptTextFromCandidateWindow(window),
    };
  }
  if (window.windowType === "transition") {
    const label = i18n.t("ambient:live.contextShiftActive");
    return {
      ...base,
      kind: "transition",
      label,
      summary: privacySuffix(label, window.privacyHint),
    };
  }
  return null;
}

function rawEventToLiveSessionItem(event: AmbientRawEvent): LiveSessionContextItem | null {
  if (event.sourceType === "transcript") return null;
  const base = {
    id: `live-raw-${event.id}`,
    startedAt: event.occurredAt,
    endedAt: event.endedAt,
    privacy: event.sensitivity,
    confidenceLabel: event.confidence !== null && event.confidence < 0.65
      ? "uncertain" as const
      : "certain" as const,
    sourceWindowIds: [],
  };
  if (event.sourceType === "health") {
    return {
      ...base,
      kind: "health",
      label: i18n.t("ambient:rawEvent.healthUpdate"),
      summary: compactSummary(event),
    };
  }
  if (event.sourceType === "location") {
    const place = placeLabelFromText(event.compactText);
    const label = locationDisplayLabel(place);
    return {
      ...base,
      kind: "place",
      label,
      ...(place ? { placeName: placeNameFromData(place) } : {}),
      summary: compactSummary(event),
    };
  }
  if (event.sourceType === "motion") {
    const label = motionLabel(event.compactText);
    return { ...base, kind: "motion", label, summary: compactSummary(event) };
  }
  if (event.sourceType === "sound") {
    const label = soundLabel(event.compactText);
    return { ...base, kind: "sound", label, summary: compactSummary(event) };
  }
  if (event.sourceType === "visit") {
    const place = placeLabelFromText(event.compactText);
    const label = place ? nearPlaceLabel(place) : i18n.t("ambient:rawEvent.placeUpdate");
    return {
      ...base,
      kind: "visit",
      label,
      ...(place ? { placeName: placeNameFromData(place) } : {}),
      summary: compactSummary(event),
    };
  }
  if (event.sourceType === "calendar") {
    return {
      ...base,
      kind: "calendar",
      label: i18n.t("ambient:rawEvent.calendarContext"),
      summary: compactSummary(event),
    };
  }
  return null;
}

function isDisplayableWindow(window: AmbientCandidateWindow): boolean {
  if (window.status === "ignored") return false;
  if (window.confidenceHint < 0.35) return false;
  return [
    "location_update",
    "visit_stay",
    "motion_state_run",
    "sound_context",
    "transcript_session",
    "transition",
  ].includes(window.windowType);
}

function isRecentWindow(window: AmbientCandidateWindow, now: Date): boolean {
  if (window.windowType === "visit_stay" || window.windowType === "transcript_session") return true;
  const ts = Date.parse(window.endedAt ?? window.startedAt);
  return Number.isFinite(ts) && now.getTime() - ts <= RECENT_CONTEXT_WINDOW_MS;
}

function compareWindowRecencyDesc(a: AmbientCandidateWindow, b: AmbientCandidateWindow): number {
  return Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt);
}

function truncateTitle(text: string): string {
  return text.length > LIVE_SESSION_TITLE_MAX
    ? `${text.slice(0, LIVE_SESSION_TITLE_MAX - 1).trimEnd()}…`
    : text;
}

function contextOnlyTitle(items: LiveSessionContextItem[]): string {
  // Branch on the `placeName` data field, not the (localized) display label.
  const place = items.find((item) => item.kind === "place" || item.kind === "visit");
  if (place?.placeName) return i18n.t("ambient:live.sensingNear", { place: place.placeName });
  if (items.some((item) => item.kind === "health")) return i18n.t("ambient:live.healthContextActive");
  return i18n.t("ambient:live.ambientContextActive");
}

function contextItemToAssist(item: LiveSessionContextItem): LiveAssistItem {
  return {
    time: formatContextOffset(item.startedAt),
    sortTs: Date.parse(item.startedAt),
    kind: "context",
    text: item.summary ?? item.label,
  };
}

function sessionSignals(
  transcriptCount: number,
  contextItems: LiveSessionContextItem[],
  provider: string,
): string[] {
  return uniqueStrings([
    ...contextItems.map((item) => item.label),
    ...(transcriptCount > 0
      ? [
          i18n.t("ambient:live.transcriptCount", { count: transcriptCount }),
          i18n.t("ambient:live.provider", { provider }),
        ]
      : []),
  ]).slice(0, MAX_SESSION_SIGNALS);
}

function deviceLabelsForContext(items: LiveSessionContextItem[]): string[] {
  if (items.some((item) => item.kind === "health")) return ["HealthKit"];
  if (items.length > 0) return ["iPhone"];
  return [];
}

function iconForContext(items: LiveSessionContextItem[]): LucideIcon {
  if (items.some((item) => item.kind === "health")) return Stethoscope;
  if (items.some((item) => item.kind === "motion")) return Activity;
  if (items.some((item) => item.kind === "place" || item.kind === "visit")) return MapPin;
  return Radio;
}

function placeLabelFromWindow(window: AmbientCandidateWindow): string | null {
  return placeLabelFromText(window.compactContext);
}

function locationDisplayLabel(place: string | null): string {
  if (!place) return i18n.t("ambient:rawEvent.locationUpdated");
  return nearPlaceLabel(place);
}

/** Strips a "Near " prefix the native English compactText may already carry. */
function placeNameFromData(place: string): string {
  return place.replace(/^Near\s+/i, "").trim();
}

function nearPlaceLabel(place: string): string {
  return i18n.t("ambient:live.nearPlace", { place: placeNameFromData(place) });
}

function placeLabelFromText(text: string): string | null {
  const trimmed = text.trim();
  const displayMatch = /^Location:\s+(.+?)\.?$/i.exec(trimmed);
  if (displayMatch?.[1]) return displayMatch[1].trim();
  const match = /(?:Location updated|Location near|Arrived|Departed) near ([^.]+)\.?/i.exec(trimmed);
  const label = match?.[1]?.trim();
  return label || null;
}

function motionLabel(context: string): string {
  // Parses the native layer's English "Motion <activity> …" sentence — input
  // format is fixed; only the rebuilt display label is translated. Unknown
  // activities fall back to the capitalized raw slug (English, on purpose).
  const match = /^Motion\s+([a-zA-Z_ -]+)/.exec(context.trim());
  const activity = match?.[1]?.split(" for ")[0]?.trim().toLowerCase();
  if (!activity) return i18n.t("ambient:live.motionActive");
  if (activity === "stationary") return i18n.t("ambient:live.motionStationary");
  if (activity === "walking") return i18n.t("ambient:live.motionWalking");
  if (activity === "automotive") return i18n.t("ambient:live.motionAutomotive");
  return activity.charAt(0).toUpperCase() + activity.slice(1);
}

function soundLabel(context: string): string {
  // Same native "Heard X for …" parsing as AmbientView.soundBody — regex
  // untouched, display templates share the ambient:sound.* keys.
  const match = /^Heard\s+(.+?)\s+for\s+/.exec(context.trim());
  const label = match?.[1]?.trim();
  const normalized = label?.toLowerCase();
  if (!label) return i18n.t("ambient:sound.detected");
  if (normalized === "speech" || normalized === "conversation") return i18n.t("ambient:sound.speech");
  if (normalized === "traffic") return i18n.t("ambient:sound.traffic");
  if (normalized === "quiet" || normalized === "quiet room") return i18n.t("ambient:sound.quietRoom");
  if (normalized === "music" || normalized === "singing") return i18n.t("ambient:sound.music");
  return i18n.t("ambient:sound.labelDetected", {
    label: label.replace(/^./, (char) => char.toUpperCase()),
  });
}

function privacySuffix(label: string, privacy: AmbientPrivacy): string {
  if (privacy === "normal") return label;
  const badge = privacy === "private"
    ? i18n.t("ambient:view.privateBadge")
    : i18n.t("ambient:view.sensitiveBadge");
  return `${label} · ${badge}`;
}

function formatContextOffset(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return i18n.t("ambient:live.timeFallback");
  return formatStartTimestamp(ts);
}

function sortLiveAssists(items: LiveAssistItem[]): LiveAssistItem[] {
  return [...items].sort((a, b) => {
    const aTs = Number.isFinite(a.sortTs) ? a.sortTs as number : Number.MAX_SAFE_INTEGER;
    const bTs = Number.isFinite(b.sortTs) ? b.sortTs as number : Number.MAX_SAFE_INTEGER;
    return aTs - bTs;
  });
}

function timestampFromDisplayTime(time: string, sessionStartedAt?: number): number | undefined {
  const offset = /^\+(\d+):(\d+)$/.exec(time);
  if (offset && sessionStartedAt !== undefined) {
    const minutes = Number(offset[1]);
    const seconds = Number(offset[2]);
    return sessionStartedAt + (minutes * 60 + seconds) * 1000;
  }
  return undefined;
}

function latestRawEventsBySource(events: AmbientRawEvent[]): AmbientRawEvent[] {
  const latest = new Map<string, AmbientRawEvent>();
  for (const event of events) {
    const existing = latest.get(event.sourceType);
    if (!existing || Date.parse(event.occurredAt) > Date.parse(existing.occurredAt)) {
      latest.set(event.sourceType, event);
    }
  }
  return Array.from(latest.values());
}

function isRecentRawEvent(event: AmbientRawEvent, now: Date): boolean {
  const ts = Date.parse(event.endedAt ?? event.occurredAt);
  return Number.isFinite(ts) && now.getTime() - ts <= RECENT_CONTEXT_WINDOW_MS;
}

function isFreshLiveTimestamp(timestamp: number): boolean {
  return Date.now() - timestamp <= CURRENT_LIVE_FRESHNESS_MS;
}

function compactSummary(event: AmbientRawEvent): string {
  if (event.sourceType === "sound") return soundLabel(event.compactText);
  return (event.compactText || `${event.sourceType} update`).trim();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
