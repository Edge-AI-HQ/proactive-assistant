/**
 * Timeline 条目模型 + mapper —— dev AmbientView 里 TimelineEntry / timelineEventToEntry /
 * latestRawEventToEntry / pendingTranscriptWindowToEntry + raw-event helper 的 RN 移植版。
 * 三路数据(LLM 时间线事件 / 最近原始事件 / 待转写窗口)归一成 TimelineEntry,AmbientScreen
 * 统一渲染(对齐 dev)。lucide-react→native;文案照 dev 走 i18n.t(key/ns 与 dev 一致)。
 */
import {
  Activity,
  Compass,
  MapPin,
  Mic,
  NotebookPen,
  Smartphone,
  Sparkles,
  Stethoscope,
  Target,
  Watch,
  Waves,
  type LucideIcon,
} from "lucide-react-native";
import {
  transcriptTextOnly,
  type AmbientCandidateWindow,
  type AmbientPrivacy,
  type AmbientRawEvent,
  type AmbientSourceType,
  type AmbientTimelineAction,
  type AmbientTimelineEvent,
} from "@pin-ai/core";

import i18n from "../i18n";

export interface TimelineEntry {
  id?: string;
  sortTs?: number;
  /** LLM 时间线事件为 true → 排序/显示优先（dev priority）。 */
  priority?: boolean;
  time: string;
  icon: LucideIcon;
  device: { name: string; icon: LucideIcon };
  privacyTag?: AmbientPrivacy;
  confidenceLabel?: "certain" | "uncertain";
  title: string;
  body: string;
  tags: string[];
  triggeredCard?: string;
  action?: AmbientTimelineAction;
  onDismiss?: () => void;
}

function formatTimelineTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ── LLM 时间线事件 ──

function isLlmSummaryEvent(event: AmbientTimelineEvent): boolean {
  return event.generationSource === "llm_summary";
}

function iconForTimelineEvent(event: AmbientTimelineEvent): LucideIcon {
  if (isLlmSummaryEvent(event)) return NotebookPen;
  if (event.sourceTypes.includes("health")) return Stethoscope;
  if (event.eventType === "transition") return Compass;
  if (event.eventType === "visit") return MapPin;
  if (event.eventType === "conversation" || event.eventType === "meeting") return Mic;
  return Sparkles;
}

function deviceIconForTimelineEvent(event: AmbientTimelineEvent): LucideIcon {
  if (isLlmSummaryEvent(event)) return Sparkles;
  if (event.sourceTypes.includes("health")) return Watch;
  if (event.sourceTypes.includes("motion")) return Activity;
  if (event.sourceTypes.includes("transcript")) return Mic;
  return Smartphone;
}

function deviceLabelForTimelineEvent(event: AmbientTimelineEvent): string {
  if (event.generationMethod === "cloud_llm") return i18n.t("ambient:summaryLabel.cloud");
  if (event.generationMethod === "local_llm") return i18n.t("ambient:summaryLabel.onDevice");
  if (isLlmSummaryEvent(event)) return i18n.t("ambient:summaryLabel.onDevice");
  return event.primarySourceLabel;
}

export function timelineEventToEntry(
  event: AmbientTimelineEvent,
  onDismiss?: (id: string) => void,
): TimelineEntry {
  const parsedTs = Date.parse(event.occurredAt);
  const action = event.actionCandidates?.[0];
  return {
    id: event.id,
    sortTs: Number.isFinite(parsedTs) ? parsedTs : 0,
    priority: true,
    time: formatTimelineTime(event.occurredAt),
    icon: iconForTimelineEvent(event),
    device: { name: deviceLabelForTimelineEvent(event), icon: deviceIconForTimelineEvent(event) },
    privacyTag: event.privacy === "normal" ? undefined : event.privacy,
    confidenceLabel: event.confidenceLabel,
    title: event.title,
    body: event.summary,
    tags: event.tags,
    triggeredCard: event.triggeredCardTitle ?? (action ? action.label : undefined),
    ...(action ? { action } : {}),
    ...(onDismiss ? { onDismiss: () => onDismiss(event.id) } : {}),
  };
}

// ── 待转写窗口 ──

export function pendingTranscriptWindowToEntry(window: AmbientCandidateWindow): TimelineEntry {
  return {
    id: `pending-${window.id}`,
    sortTs: Date.parse(window.startedAt),
    time: formatTimelineTime(window.startedAt),
    icon: Mic,
    device: { name: i18n.t("ambient:rawEvent.microphone"), icon: Mic },
    privacyTag: "private",
    confidenceLabel: undefined,
    title: i18n.t("ambient:rawEvent.voiceTranscript"),
    body: transcriptWindowPreview(window.compactContext),
    tags: ["voice"],
  };
}

// ── 最近原始事件（每源最新一条）──

export function latestRawEventToEntry(raw: AmbientRawEvent): TimelineEntry {
  return {
    id: `latest-raw-${raw.id}`,
    sortTs: Date.parse(raw.occurredAt),
    time: formatTimelineTime(raw.occurredAt),
    icon: iconForRawEvent(raw.sourceType),
    device: { name: deviceLabelForRawEvent(raw), icon: deviceIconForRawEvent(raw.sourceType) },
    privacyTag: raw.sensitivity === "normal" ? undefined : raw.sensitivity,
    confidenceLabel: confidenceLabelForRawEvent(raw),
    title: titleForRawEvent(raw.sourceType),
    body: rawEventBody(raw),
    tags: tagsForRawEvent(raw),
  };
}

function iconForRawEvent(sourceType: AmbientSourceType): LucideIcon {
  if (sourceType === "health") return Stethoscope;
  if (sourceType === "transcript") return Mic;
  if (sourceType === "location") return MapPin;
  if (sourceType === "motion") return Activity;
  if (sourceType === "sound") return Waves;
  if (sourceType === "visit") return MapPin;
  if (sourceType === "calendar") return Target;
  return Sparkles;
}

function deviceIconForRawEvent(sourceType: AmbientSourceType): LucideIcon {
  if (sourceType === "health") return Watch;
  if (sourceType === "transcript") return Mic;
  if (sourceType === "motion") return Activity;
  if (sourceType === "sound") return Mic;
  if (sourceType === "visit") return MapPin;
  if (sourceType === "calendar") return Smartphone;
  return Smartphone;
}

function deviceLabelForRawEvent(raw: AmbientRawEvent): string {
  if (raw.sourceType === "health") return "HealthKit";
  if (raw.sourceType === "transcript") return i18n.t("ambient:rawEvent.microphone");
  if (raw.sourceType === "location") return i18n.t("ambient:rawEvent.location");
  if (raw.sourceType === "motion") return i18n.t("ambient:rawEvent.motion");
  if (raw.sourceType === "sound") return i18n.t("ambient:rawEvent.microphone");
  if (raw.sourceType === "visit") return i18n.t("ambient:rawEvent.places");
  if (raw.sourceType === "calendar") return i18n.t("ambient:rawEvent.calendar");
  return raw.sourceType;
}

function titleForRawEvent(sourceType: AmbientSourceType): string {
  if (sourceType === "health") return i18n.t("ambient:rawEvent.healthUpdate");
  if (sourceType === "transcript") return i18n.t("ambient:rawEvent.voiceTranscript");
  if (sourceType === "location") return i18n.t("ambient:rawEvent.locationUpdated");
  if (sourceType === "motion") return i18n.t("ambient:rawEvent.motionUpdate");
  if (sourceType === "sound") return i18n.t("ambient:rawEvent.soundContext");
  if (sourceType === "visit") return i18n.t("ambient:rawEvent.placeUpdate");
  if (sourceType === "calendar") return i18n.t("ambient:rawEvent.calendarContext");
  return i18n.t("ambient:rawEvent.contextUpdate");
}

function tagsForRawEvent(raw: AmbientRawEvent): string[] {
  if (raw.sourceType === "health") return ["health", "latest"];
  if (raw.sourceType === "transcript") return ["voice", "latest"];
  if (raw.sourceType === "location") return ["location", "latest"];
  if (raw.sourceType === "motion") return ["motion", "latest"];
  if (raw.sourceType === "sound") return ["sound", "latest"];
  if (raw.sourceType === "visit") return ["place", "latest"];
  if (raw.sourceType === "calendar") return ["calendar", "latest"];
  return [raw.sourceType, "latest"];
}

function confidenceLabelForRawEvent(raw: AmbientRawEvent): TimelineEntry["confidenceLabel"] {
  if (raw.confidence === null) return undefined;
  return raw.confidence >= 0.65 ? "certain" : "uncertain";
}

function rawEventBody(raw: AmbientRawEvent): string {
  if (raw.sourceType === "transcript") return transcriptWindowPreview(raw.compactText);
  if (raw.sourceType === "sound") return soundBody(raw.compactText);
  return raw.compactText || i18n.t("ambient:rawEvent.captured", { title: titleForRawEvent(raw.sourceType) });
}

function soundBody(text: string): string {
  const match = /^Heard\s+(.+?)\s+for\s+/.exec(text.trim());
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

function transcriptWindowPreview(compactContext: string): string {
  const transcriptText = transcriptTextOnly(compactContext);
  const segments = (transcriptText || i18n.t("ambient:transcript.captured"))
    .split(/Transcript segment:\s*/g)
    .map((part) => part.replace(/^Sound context:\s*/i, "").trim())
    .filter(Boolean);
  const unique: string[] = [];
  for (const segment of segments) {
    if (unique[unique.length - 1] !== segment) unique.push(segment);
  }
  const text = (unique.join(" ") || compactContext).trim();
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}
