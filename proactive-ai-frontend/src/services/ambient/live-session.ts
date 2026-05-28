import type { TranscriptReadyEvent } from "@pin/capacitor-ambient-ai";
import { speakerAwareTranscriptTextFromPayload } from "./speaker-transcript";
import type { AmbientCandidateWindow, AmbientPrivacy, AmbientRawEvent } from "./timeline";
import {
  Activity,
  Coffee,
  MapPin,
  Mic,
  Radio,
  Stethoscope,
  Users,
  type LucideIcon,
} from "lucide-react";

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

export interface LiveTranscriptUpdate {
  captureSessionId: string;
  id: string;
  text: string;
  source?: string;
  receivedAt?: number;
}

const MAX_LIVE_MESSAGES = 30;
const LIVE_SESSION_TITLE_MAX = 64;
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
  label: string;
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

export function appendTranscript(
  prev: LiveSessionData | null,
  event: TranscriptReadyEvent,
): LiveSessionData {
  return appendLiveTranscript(prev, {
    captureSessionId: event.captureSessionId,
    id: event.burstId || `${event.captureSessionId}:${Date.now()}`,
    text: event.text,
    source: event.provider,
  });
}

export function appendLiveTranscript(
  prev: LiveSessionData | null,
  update: LiveTranscriptUpdate,
): LiveSessionData {
  const text = update.text.trim();
  if (isHiddenLiveTranscriptText(text)) {
    return prev ?? emptyLiveSessionData(update.captureSessionId, update.receivedAt ?? Date.now());
  }
  const receivedAt = update.receivedAt ?? Date.now();
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
): LiveSessionData | null {
  const transcripts = events
    .filter((event) => event.sourceType === "transcript")
    .filter((event) => event.eventType === "transcript.ready")
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const latest = transcripts[transcripts.length - 1];
  if (!latest) return null;

  const captureSessionId = transcriptCaptureSessionId(latest);
  const sessionEvents = transcripts.filter(
    (event) => transcriptCaptureSessionId(event) === captureSessionId,
  );
  const startedAt = Date.parse(sessionEvents[0]?.occurredAt ?? latest.occurredAt);
  const start = Number.isFinite(startedAt) ? startedAt : Date.now();
  const messages = sessionEvents
    .map((event) => rawTranscriptEventToMessage(event, start))
    .filter((message): message is LiveAssistMessage => message !== null)
    .slice(-MAX_LIVE_MESSAGES);

  if (messages.length === 0) return null;
  return {
    captureSessionId,
    startedAt: start,
    messages,
  };
}

export function liveSessionDataToSession(
  ambientOn: boolean,
  data: LiveSessionData | null,
  contextItems: LiveSessionContextItem[] = [],
): LiveSession | null {
  if (!ambientOn) return null;
  const hasTranscript = !!data && data.messages.length > 0;
  const visibleContext = contextItems.slice(0, MAX_CONTEXT_ASSISTS);
  if (!hasTranscript && visibleContext.length === 0) return null;
  const transcriptContextMessages = hasTranscript ? [] : transcriptContextToMessages(visibleContext);
  const transcriptMessages = data?.messages ?? transcriptContextMessages;
  const hasDisplayTranscript = transcriptMessages.length > 0;
  const displayContext = hasDisplayTranscript
    ? visibleContext.filter((item) => item.kind !== "transcript")
    : visibleContext;
  const last = hasDisplayTranscript ? transcriptMessages[transcriptMessages.length - 1] : null;
  const title = last
    ? truncateTitle(last.text) || "Live transcript"
    : contextOnlyTitle(displayContext);
  const provider = last?.source ?? "device";
  const primaryPlace = displayContext.find((item) => item.kind === "place" || item.kind === "visit");
  const location = primaryPlace?.label ?? (hasDisplayTranscript ? "On device · captured locally" : "Ambient context active");
  const device = uniqueStrings([
    ...(hasDisplayTranscript ? ["Microphone"] : []),
    ...deviceLabelsForContext(displayContext),
  ]).join(" · ") || "Ambient sensors";
  const startedAt = data
    ? formatStartTimestamp(data.startedAt)
    : formatStartTimestamp(Date.parse(displayContext[displayContext.length - 1]?.startedAt ?? new Date().toISOString()));

  return {
    icon: hasDisplayTranscript ? Mic : iconForContext(displayContext),
    kind: hasDisplayTranscript ? "Voice session" : "Ambient context",
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



function rawTranscriptEventToMessage(
  event: AmbientRawEvent,
  _sessionStartedAt: number,
): LiveAssistMessage | null {
  const text = transcriptTextFromRaw(event);
  if (!text) return null;
  const occurredAt = Date.parse(event.occurredAt);
  return {
    id: transcriptBurstId(event) ?? event.id,
    time: Number.isFinite(occurredAt) ? formatStartTimestamp(occurredAt) : "live",
    sortTs: Number.isFinite(occurredAt) ? occurredAt : undefined,
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
      summary: privacySuffix(label, window.privacyHint),
    };
  }
  if (window.windowType === "visit_stay") {
    const place = placeLabelFromWindow(window);
    const label = place ? `Near ${place}` : "Visit context active";
    return { ...base, kind: "visit", label, summary: privacySuffix(label, window.privacyHint) };
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
    return {
      ...base,
      kind: "transcript",
      label: "Conversation window active",
      summary: privacySuffix("Conversation window active", window.privacyHint),
      transcriptText: () => transcriptTextFromCandidateWindow(window),
    };
  }
  if (window.windowType === "transition") {
    return {
      ...base,
      kind: "transition",
      label: "Context shift active",
      summary: privacySuffix("Context shift active", window.privacyHint),
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
    return { ...base, kind: "health", label: "Health update", summary: compactSummary(event) };
  }
  if (event.sourceType === "location") {
    const place = placeLabelFromText(event.compactText);
    const label = locationDisplayLabel(place);
    return { ...base, kind: "place", label, summary: compactSummary(event) };
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
    const label = place ? `Near ${place}` : "Place update";
    return { ...base, kind: "visit", label, summary: compactSummary(event) };
  }
  if (event.sourceType === "calendar") {
    return { ...base, kind: "calendar", label: "Calendar context", summary: compactSummary(event) };
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
  const place = items.find((item) => item.kind === "place" || item.kind === "visit");
  if (place?.label.startsWith("Near ")) return `Sensing near ${place.label.slice(5)}`;
  if (items.some((item) => item.kind === "health")) return "Health context active";
  return "Ambient context active";
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
          `${transcriptCount} transcript${transcriptCount === 1 ? "" : "s"}`,
          `Provider: ${provider}`,
        ]
      : []),
  ]).slice(0, MAX_SESSION_SIGNALS);
}

function transcriptContextToMessages(items: LiveSessionContextItem[]): LiveAssistMessage[] {
  return items
    .filter((item) => item.kind === "transcript")
    .flatMap((item) => {
      const text = item.transcriptText?.()?.trim();
      if (!text || text.startsWith("Conversation window active")) return [];
      return [{
        id: item.id,
        time: formatStartTimestamp(Date.parse(item.startedAt)),
        sortTs: Date.parse(item.startedAt),
        text,
        source: "local transcript",
      }];
    });
}

function deviceLabelsForContext(items: LiveSessionContextItem[]): string[] {
  if (items.some((item) => item.kind === "transcript")) return ["Microphone"];
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
  if (!place) return "Location updated";
  return /^Near\s+/i.test(place) ? place : `Near ${place}`;
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
  const match = /^Motion\s+([a-zA-Z_ -]+)/.exec(context.trim());
  const activity = match?.[1]?.split(" for ")[0]?.trim().toLowerCase();
  if (!activity) return "Motion active";
  if (activity === "stationary") return "Stationary";
  if (activity === "walking") return "Walking";
  if (activity === "automotive") return "Automotive";
  return activity.charAt(0).toUpperCase() + activity.slice(1);
}

function soundLabel(context: string): string {
  const match = /^Heard\s+(.+?)\s+for\s+/.exec(context.trim());
  const label = match?.[1]?.trim();
  const normalized = label?.toLowerCase();
  if (!label) return "Sound detected";
  if (normalized === "speech" || normalized === "conversation") return "Speech detected";
  if (normalized === "traffic") return "Traffic sound detected";
  if (normalized === "quiet" || normalized === "quiet room") return "Quiet room";
  if (normalized === "music" || normalized === "singing") return "Music detected";
  return `${label.replace(/^./, (char) => char.toUpperCase())} detected`;
}

function privacySuffix(label: string, privacy: AmbientPrivacy): string {
  return privacy === "normal" ? label : `${label} · ${privacy}`;
}

function formatContextOffset(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "live";
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

function compactSummary(event: AmbientRawEvent): string {
  if (event.sourceType === "sound") return soundLabel(event.compactText);
  return (event.compactText || `${event.sourceType} update`).trim();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export const LIVE_SCENARIOS: LiveSession[] = [
  {
    icon: Users,
    kind: "Meeting",
    title: "Product review with design team",
    location: "Conference Room B · WeWork",
    device: "AirPods Pro · Watch",
    startedAt: "14:32",
    signals: ["5 voices detected", "Cadence: discussion", "HR 78"],
    assists: [
      { time: "+00:18", kind: "context", text: "Meeting started. 5 voices detected — Sarah, Marcus, Priya, Devon, you.", source: "Voice ID" },
      { time: "+00:42", kind: "context", text: "Sarah referenced the \"north-star metric\" from the Jan deck.", source: "Notion" },
      { time: "+01:24", kind: "assist", text: "Jan deck open on your watch — jumped to slide 7 (north-star definition).", source: "Drive" },
      { time: "+02:15", kind: "assist", text: "Pulled slide 12 (\"Activation funnel — Q1\") to your watch.", source: "Drive" },
      { time: "+03:01", kind: "context", text: "Devon brought up the iOS 18 widget refresh bug — filed as LIN-842 last Tuesday.", source: "Linear" },
      { time: "+03:48", kind: "assist", text: "LIN-842 thread summary surfaced. 3 unread comments from engineering.", source: "Linear" },
      { time: "+04:08", kind: "context", text: "Marcus mentioned the onboarding drop-off at step 3 — same issue raised in last week's retro.", source: "Linear" },
      { time: "+04:55", kind: "assist", text: "Retro notes from Apr 18 pulled. Step-3 drop-off was 34% — Priya owned the audit.", source: "Notion" },
      { time: "+05:30", kind: "action", text: "Drafted action item: \"Audit step-3 onboarding by Fri.\" Tap to assign.", source: "Linear draft" },
      { time: "+06:12", kind: "context", text: "Sarah asked about Q2 OKR alignment — your draft is in Notion.", source: "Notion" },
      { time: "+06:48", kind: "action", text: "Q2 OKR draft ready to share. Tap to send to the room.", source: "Notion" },
      { time: "+07:30", kind: "assist", text: "Decision detected: ship v2 onboarding behind a flag by May 9. Logged.", source: "Decision log" },
    ],
  },
  {
    icon: Stethoscope,
    kind: "Medical visit",
    title: "Annual check-up with Dr. Patel",
    location: "UCSF Medical Center",
    device: "iPhone · Watch",
    startedAt: "11:20",
    signals: ["Clinical vocabulary", "Quiet room", "HRV ↓"],
    assists: [
      { time: "+00:30", kind: "context", text: "Visit started. Vitals from Apple Health pre-shared with Dr. Patel's chart.", source: "Apple Health" },
      { time: "+01:05", kind: "context", text: "Dr. Patel mentioned \"LDL apolipoprotein B\" — a marker for cardiovascular risk.", source: "Glossary" },
      { time: "+01:48", kind: "assist", text: "ApoB explained on your watch — what it measures, why it matters, your last value.", source: "Glossary" },
      { time: "+02:40", kind: "assist", text: "Plain-English summary of all lab terms used so far is ready on your watch.", source: "Health" },
      { time: "+03:22", kind: "context", text: "She referenced your March lipid panel — values pulled from Apple Health.", source: "Apple Health" },
      { time: "+04:00", kind: "action", text: "Suggested follow-up questions queued: \"What lifestyle changes move ApoB the most?\"", source: "Notes draft" },
      { time: "+04:42", kind: "context", text: "Dr. Patel recommended a 3-month lipid recheck. Calendar slot suggested.", source: "Calendar" },
      { time: "+05:18", kind: "action", text: "Tentative follow-up: Jul 24, 11:00 AM. Tap to confirm.", source: "Calendar draft" },
      { time: "+06:05", kind: "assist", text: "Dietary changes that move ApoB the most: saturated fat ↓, soluble fiber ↑.", source: "Mayo Clinic" },
    ],
  },
  {
    icon: Coffee,
    kind: "Casual chat",
    title: "Lunch with Marcus — boba craving detected",
    location: "Blue Bottle · Mission St",
    device: "AirPods Pro",
    startedAt: "13:45",
    signals: ["2 voices", "Casual tone", "Stationary 18m"],
    assists: [
      { time: "+00:12", kind: "context", text: "Lunch with Marcus started. Casual tone, low-stakes conversation." },
      { time: "+00:30", kind: "context", text: "Heard you say \"I could really go for boba right now.\"" },
      { time: "+00:35", kind: "assist", text: "Boba Guys (3 min walk) — your usual: Strawberry Matcha, 50% sugar, no ice.", source: "Order history" },
      { time: "+00:38", kind: "action", text: "Order ready to place. Say \"go\" or tap to confirm.", source: "DoorDash draft" },
      { time: "+01:20", kind: "context", text: "Marcus mentioned his sister's wedding next month — added to your relationship notes.", source: "Notes" },
      { time: "+02:05", kind: "assist", text: "Reminder set: ask Marcus about the wedding when you see him next week.", source: "Reminders" },
      { time: "+02:48", kind: "context", text: "He brought up the Sequoia call — that's tomorrow at 10am for you.", source: "Calendar" },
      { time: "+03:30", kind: "assist", text: "Sequoia prep doc pinned to your morning briefing.", source: "Notion" },
    ],
  },
];
