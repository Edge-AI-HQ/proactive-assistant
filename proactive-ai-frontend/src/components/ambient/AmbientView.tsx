import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect, forwardRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { isNative } from "@/lib/platform";
import {
  Radio, Smartphone, Watch, Laptop,
  MapPin, Compass, Mic, Activity, Wifi,
  Stethoscope,
  Lightbulb, Sparkles, Plus, ChevronDown, ChevronRight, X,
  Phone, Sun, Waves, Target,
  Soup, Minimize2, Lock, Unlock,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";
import { useUserSettings, useUserDevices } from "@pin-ai/state";
import type { UserDevice, UserDevicePlatform } from "@pin-ai/core";
import { useAmbientTimeline } from "@/hooks/useAmbientTimeline";
import { useAmbientLiveSession } from "@/hooks/useAmbientLiveSession";
import { useAmbientToggle } from "@/hooks/useAmbientToggle";
import LiveSessionCard from "@/components/ambient/LiveSessionCard";
import AmbientModelRequiredCard from "@/components/ambient/AmbientModelRequiredCard";
import AmbientModelSetupStep from "@/components/onboarding/AmbientModelSetupStep";
import type {
  AmbientCandidateWindow,
  AmbientPrivacy,
  AmbientRawEvent,
  AmbientSourceType,
  AmbientTimelineAction,
  AmbientTimelineEvent,
} from "@/services/ambient/timeline";
import type { RuntimeStatus } from "@/services/ambient";
import type { LiveAssistItem, LiveSession } from "@/services/ambient/live-session";
import { transcriptTextOnly } from "@/services/ambient/timeline/utils";
import { Text, i18n } from "@pin-ai/ui-web";

/* ──────────────── TIMELINE (today's narrative) ──────────────── */

const LIVE_FULLSCREEN_VIEWPORT_FADE_MASK =
  "linear-gradient(to bottom, rgba(0, 0, 0, 0.18) 0%, rgba(0, 0, 0, 0.34) 22%, rgba(0, 0, 0, 0.62) 44%, rgba(0, 0, 0, 0.88) 62%, black 76%, black 100%)";

export type { AmbientTimelineAction };

export interface TimelineEntry {
  id?: string;
  sortTs?: number;
  priority?: boolean;
  time: string;
  icon: LucideIcon;
  device: { name: string; icon: LucideIcon };
  privacyTag?: AmbientPrivacy;
  confidenceLabel?: "certain" | "uncertain";
  title: string;
  body: string;
  tags: string[];
  triggeredCard?: string; // ID/name of card it triggered in NOW feed
  action?: AmbientTimelineAction;
  onDismiss?: () => void;
}

/** Web-preview mock timeline. Copy comes from the ambient namespace so the
 *  demo follows the UI language; the `goal` strings are LLM prompts and stay
 *  English by design. Demo clock times / device brand names are data. */
function demoTimeline(t: TFunction<"ambient">): TimelineEntry[] {
  return [
    {
      time: "9:12 AM",
      icon: Sun,
      device: { name: "Apple Watch", icon: Watch },
      title: t("demo.morningTitle"),
      body: t("demo.morningBody"),
      tags: [t("demo.tags.sleep"), t("demo.tags.commute")],
    },
    {
      id: "t-investor",
      time: "10:03 AM",
      icon: Phone,
      device: { name: "MacBook", icon: Laptop },
      privacyTag: "private",
      title: t("demo.investorTitle"),
      body: t("demo.investorBody"),
      tags: [t("demo.tags.work"), t("demo.tags.call")],
      triggeredCard: t("demo.investorCard"),
      action: {
        label: t("demo.investorAction"),
        goal: "Draft a follow-up email to Mike K. recapping the Sequoia bridge call and attach the updated cap table.",
        goalBasket: "work",
      },
    },
    {
      id: "t-lunch",
      time: "12:40 PM",
      icon: Soup,
      device: { name: "iPhone", icon: Smartphone },
      privacyTag: "private",
      title: t("demo.lunchTitle"),
      body: t("demo.lunchBody"),
      tags: [t("demo.tags.life"), t("demo.tags.social")],
      triggeredCard: t("demo.lunchCard"),
      action: {
        label: t("demo.lunchAction"),
        goal: "Add a tentative calendar hold for Priya's sister's wedding in June and remind me to confirm the exact date with Priya.",
        goalBasket: "life",
      },
    },
    {
      time: "1:15 PM",
      icon: Target,
      device: { name: "MacBook", icon: Laptop },
      title: t("demo.focusTitle"),
      body: t("demo.focusBody"),
      tags: [t("demo.tags.focus"), t("demo.tags.work")],
      triggeredCard: t("demo.focusCard"),
    },
    {
      time: "2:30 PM",
      icon: MapPin,
      device: { name: "iPhone", icon: Smartphone },
      title: t("demo.transitionTitle"),
      body: t("demo.transitionBody"),
      tags: [t("demo.tags.transition")],
      triggeredCard: t("demo.transitionCard"),
    },
    {
      time: "4:45 PM",
      icon: Waves,
      device: { name: "Apple Watch", icon: Watch },
      title: t("demo.swimTitle"),
      body: t("demo.swimBody"),
      tags: [t("demo.tags.health"), t("demo.tags.fitness")],
    },
  ];
}

const INITIAL_TIMELINE_VISIBLE_COUNT = 10;
const TIMELINE_LOAD_MORE_COUNT = 10;

function formatTimelineTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

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

function timelineEventToEntry(
  event: AmbientTimelineEvent,
  onDismiss: (id: string) => void,
): TimelineEntry {
  const parsedTs = Date.parse(event.occurredAt);
  const action = event.actionCandidates?.[0];
  return {
    id: event.id,
    sortTs: Number.isFinite(parsedTs) ? parsedTs : 0,
    priority: true,
    time: formatTimelineTime(event.occurredAt),
    icon: iconForTimelineEvent(event),
    device: {
      name: deviceLabelForTimelineEvent(event),
      icon: deviceIconForTimelineEvent(event),
    },
    privacyTag: event.privacy === "normal" ? undefined : event.privacy,
    confidenceLabel: event.confidenceLabel,
    title: event.title,
    body: event.summary,
    tags: event.tags,
    triggeredCard: event.triggeredCardTitle ?? (action ? action.label : undefined),
    ...(action ? { action } : {}),
    onDismiss: () => onDismiss(event.id),
  };
}

function pendingTranscriptWindowToEntry(window: AmbientCandidateWindow): TimelineEntry {
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

function latestRawEventToEntry(raw: AmbientRawEvent): TimelineEntry {
  return {
    id: `latest-raw-${raw.id}`,
    sortTs: Date.parse(raw.occurredAt),
    time: formatTimelineTime(raw.occurredAt),
    icon: iconForRawEvent(raw.sourceType),
    device: {
      name: deviceLabelForRawEvent(raw),
      icon: deviceIconForRawEvent(raw.sourceType),
    },
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

function confidenceLabelForRawEvent(
  raw: AmbientRawEvent,
): TimelineEntry["confidenceLabel"] {
  if (raw.confidence === null) return undefined;
  return raw.confidence >= 0.65 ? "certain" : "uncertain";
}

function rawEventBody(raw: AmbientRawEvent): string {
  if (raw.sourceType === "transcript") {
    return transcriptWindowPreview(raw.compactText);
  }
  if (raw.sourceType === "sound") {
    return soundBody(raw.compactText);
  }
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

function iconForUserDevice(platform: UserDevicePlatform): LucideIcon {
  if (platform === "wearable") return Watch;
  if (platform === "sensor") return Activity;
  if (platform === "embedded") return Laptop;
  return Smartphone;
}

function titleForUserDevice(device: UserDevice): string {
  const name = device.display_name ?? device.model ?? device.device_id;
  const detail = [
    device.model,
    device.app_version
      ? i18n.t("ambient:deviceStrip.appVersion", { version: device.app_version })
      : null,
    device.last_seen_at
      ? i18n.t("ambient:deviceStrip.lastSeen", {
        time: formatDeviceRelativeTime(device.last_seen_at),
      })
      : null,
  ].filter(Boolean);
  return detail.length > 0 ? `${name} · ${detail.join(" · ")}` : name;
}

function signalClassForUserDevice(device: UserDevice): string {
  if (!device.last_seen_at) return "bg-amber-500";
  const ageMs = Date.now() - new Date(device.last_seen_at).getTime();
  return ageMs > 24 * 60 * 60 * 1000 ? "bg-amber-500" : "bg-emerald-500";
}

function formatDeviceRelativeTime(iso: string): string {
  const ageSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  // narrow style keeps the compact "5m ago" look while localizing the unit
  // and word order (zero new translation keys).
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "always", style: "narrow" });
  if (ageSec < 60) return rtf.format(-ageSec, "second");
  if (ageSec < 3600) return rtf.format(-Math.round(ageSec / 60), "minute");
  if (ageSec < 86400) return rtf.format(-Math.round(ageSec / 3600), "hour");
  return rtf.format(-Math.round(ageSec / 86400), "day");
}

function deviceStripSummary(
  connectedCount: number,
  loading: boolean,
  error: string | null,
  hiddenDeviceCount: number,
): string {
  if (loading && connectedCount === 0) return i18n.t("ambient:view.deviceCountLoading");
  if (error && connectedCount === 0) return i18n.t("ambient:deviceStrip.unavailable");
  if (hiddenDeviceCount > 0) {
    return i18n.t("ambient:deviceStrip.moreConnected", { count: hiddenDeviceCount });
  }
  if (connectedCount > 0) return i18n.t("ambient:deviceStrip.manage");
  return i18n.t("ambient:deviceStrip.nonePaired");
}

/* ──────────────── COMPONENT ──────────────── */

interface AmbientViewProps {
  onConnectMore?: () => void;
  autoOpenLive?: boolean;
  onAutoOpenHandled?: () => void;
  /** Parent owns the fullscreen overlay; Ambient only requests it. */
  onOpenFullscreen?: (session: LiveSession) => void;
  /** Bubble Action-chip clicks up to parent so it can hand off to the
   *  existing CardChat → MainChatView runtime (B+ Action handoff MVP).
   *  Only invoked for entries that define `entry.action`. */
  onAmbientAction?: (entry: TimelineEntry) => void;
}

export default function AmbientView({ onConnectMore, autoOpenLive, onAutoOpenHandled, onOpenFullscreen, onAmbientAction }: AmbientViewProps = {}) {
  const { t } = useTranslation("ambient");
  const { settings } = useUserSettings();
  const { devices, loading: devicesLoading, error: devicesError } = useUserDevices(true);
  const ambientTimeline = useAmbientTimeline();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  // Master ambient switch — settings patch + localStorage + native lifecycle.
  // The same hook drives the NOW-view toggle in AppLayout so a flip
  // from either place stays consistent.
  const {
    ambientOn: hookAmbientOn,
    togglePending,
    toggle: handleAmbientToggle,
  } = useAmbientToggle();
  const [timelineVisibleCount, setTimelineVisibleCount] = useState(INITIAL_TIMELINE_VISIBLE_COUNT);
  const [modelSetupOpen, setModelSetupOpen] = useState(false);
  const connectedDevices = useMemo(
    () => devices.filter((d) => d.status === "active" && d.platform !== "web"),
    [devices],
  );
  const visibleConnectedDevices = connectedDevices.slice(0, 5);
  const connectedCount = connectedDevices.length;
  const hiddenDeviceCount = Math.max(0, connectedCount - visibleConnectedDevices.length);
  const deviceCountLabel = devicesLoading && connectedCount === 0
    ? t("view.deviceCountLoading")
    : devicesError && connectedCount === 0
      ? t("view.deviceCountUnavailable")
      : t("view.deviceCount", { count: connectedCount });

  // Shared with the NOW-view toggle via useAmbientToggle. Don't OR with
  // runtimeStatus.sources.enabled — that was an old flicker-prevention net
  // for cold boot, but it caused the toggle to keep showing ON for ~200ms
  // after a "stop" while lifecycle was still tearing the sensors down.
  // useAmbientToggle's own fallback (localStorage boot flag while consent
  // is null) already prevents the original cold-boot flicker.
  const ambientOn = hookAmbientOn;
  const uploadsLocked = runtimeStatus?.uploadsLocked ?? false;
  const firstSourceError =
    runtimeStatus?.sources.find((s) => s.lastError)?.lastError ?? null;

  // Subscribe to the ambient runtime via dynamic import: the runtime
  // module statically depends on @pin/capacitor-ambient-ai (and friends),
  // which is rollup-external on the web build. Keeping the load behind
  // a runtime ``isNative`` guard means the web chunk is never fetched
  // at all and the main bundle stays free of bare native specifiers.
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {
        const { getAmbientRuntime, getExistingAmbientRuntime } = await import("@/services/ambient");
        if (cancelled) return;
        const rt = ambientOn ? getAmbientRuntime() : getExistingAmbientRuntime();
        if (!rt) {
          console.info("[ambient-power] AmbientView runtime subscription skipped; ambient is off");
          setRuntimeStatus(null);
          return;
        }
        setRuntimeStatus(rt.status());
        unsubscribe = rt.subscribe(() => setRuntimeStatus(rt.status()));
      } catch {
        // Module load failed; UI keeps the null status fallback.
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [ambientOn]);

  const handleLockToggle = useCallback(() => {
    if (!isNative) return;
    void (async () => {
      try {
        const { getAmbientRuntime } = await import("@/services/ambient");
        getAmbientRuntime().setUploadsLocked(!uploadsLocked);
      } catch {
        // ignore — UI state stays in sync via the subscription effect.
      }
    })();
  }, [uploadsLocked]);

  const {
    session: liveSession,
    previewVisibleCount,
    dismiss: dismissLiveSession,
  } = useAmbientLiveSession({
    ambientOn,
    enableWebDemo: !isNative,
    dismissible: true,
  });

  // Auto-open fullscreen when triggered from outside (e.g., Constellation Live row)
  useEffect(() => {
    if (autoOpenLive && liveSession) {
      onOpenFullscreen?.(liveSession);
      onAutoOpenHandled?.();
    }
  }, [autoOpenLive, liveSession, onOpenFullscreen, onAutoOpenHandled]);

  const handleDismissTimelineEvent = useCallback((id: string) => {
    void ambientTimeline.dismiss(id);
  }, [ambientTimeline.dismiss]);

  const useWebPreviewTimeline = !isNative && ambientTimeline.events.length === 0;
  const timelineEntries = useMemo<TimelineEntry[]>(() => {
    if (useWebPreviewTimeline) return demoTimeline(t);
    const pendingTranscriptWindows = ambientTimeline.pendingTranscriptWindows ?? [];
    const latestRawEvents = ambientTimeline.latestRawEvents ?? [];
    return [
      ...ambientTimeline.events.map((event) =>
        timelineEventToEntry(event, handleDismissTimelineEvent),
      ),
      ...pendingTranscriptWindows.map(pendingTranscriptWindowToEntry),
      ...latestRawEvents.map(latestRawEventToEntry),
    ].sort((a, b) => {
      const aTs = Number.isFinite(a.sortTs) ? (a.sortTs as number) : 0;
      const bTs = Number.isFinite(b.sortTs) ? (b.sortTs as number) : 0;
      return bTs - aTs;
    });
  }, [
    ambientTimeline.events,
    ambientTimeline.latestRawEvents,
    ambientTimeline.pendingTranscriptWindows,
    handleDismissTimelineEvent,
    useWebPreviewTimeline,
    t,
  ]);
  const visibleTimelineEntries = useMemo<TimelineEntry[]>(() => {
    if (useWebPreviewTimeline) return timelineEntries.slice(0, timelineVisibleCount);
    const priorityEntries = timelineEntries.filter((entry) => entry.priority);
    const otherEntries = timelineEntries.filter((entry) => !entry.priority);
    const remainingSlots = Math.max(0, timelineVisibleCount - priorityEntries.length);
    return [...priorityEntries, ...otherEntries.slice(0, remainingSlots)];
  }, [timelineEntries, timelineVisibleCount, useWebPreviewTimeline]);
  const canLoadMoreTimelineEntries = visibleTimelineEntries.length < timelineEntries.length;

  useEffect(() => {
    setTimelineVisibleCount(INITIAL_TIMELINE_VISIBLE_COUNT);
  }, [ambientTimeline.localDate]);

  const handleConnectMore = () => {
    if (onConnectMore) onConnectMore();
    else if (typeof window !== "undefined") window.location.href = "/control";
  };

  return (
    <div
      className="h-full overflow-y-auto overflow-x-hidden pb-32 px-4"
      style={{ paddingTop: "var(--constellation-header-top, calc(0.875rem + env(safe-area-inset-top, 0px)))" }}
    >
      {/* ── Header ── */}
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight leading-tight">
          {t("view.title")}
        </h1>
        <div className="mt-1 flex items-center gap-1.5 text-bodySm text-foreground/60">
          <span>{deviceCountLabel}</span>
          <span className="text-foreground/30">·</span>
          <span>{t("view.onDeviceTee")}</span>
        </div>
      </div>

      {/* ── Ambient hero switch — B&W with waveform ── */}
      <div
        className="rounded-2xl mb-5 p-4 flex items-center justify-between border"
        style={{
          background: ambientOn
            ? "linear-gradient(180deg, hsl(0 0% 100% / 0.7), hsl(0 0% 100% / 0.4))"
            : "linear-gradient(180deg, hsl(0 0% 100% / 0.4), hsl(0 0% 100% / 0.25))",
          borderColor: "hsl(0 0% 100% / 0.5)",
          backdropFilter: "blur(20px) saturate(1.4)",
          WebkitBackdropFilter: "blur(20px) saturate(1.4)",
          boxShadow: ambientOn ? "0 4px 24px hsl(0 0% 0% / 0.06)" : undefined,
        }}
      >
        <div className="flex items-center gap-3">
          {/* Radio icon with ping ring */}
          <div className="relative">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${ambientOn ? "bg-foreground text-background" : "bg-foreground/10 text-foreground/40"
                }`}
            >
              <Radio size={14} strokeWidth={2.2} />
            </div>
            {ambientOn && (
              <>
                <span className="absolute inset-0 rounded-full animate-ping bg-foreground/15" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              </>
            )}
          </div>

          <div className="min-w-0">
            <Text variant="bodySm" weight="semibold" className="block text-foreground leading-tight">
              {ambientOn ? t("view.ambientOn") : t("view.ambientOff")}
            </Text>
            <Text variant="caption" className="block text-foreground/55 leading-tight mt-0.5 truncate">
              {!ambientOn
                ? t("view.statusPaused")
                : uploadsLocked
                  ? t("view.statusUploadsPaused")
                  : firstSourceError
                    ? firstSourceError
                    : t("view.statusListening")}
            </Text>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Soft upload lock — keeps local capture going while suspending sync. */}
          {ambientOn && (
            <button
              onClick={handleLockToggle}
              className={`w-9 h-9 rounded-full flex items-center justify-center border transition-colors ${uploadsLocked
                ? "bg-foreground text-background border-foreground"
                : "bg-foreground/[0.04] text-foreground/60 hover:bg-foreground/[0.08] hover:text-foreground border-foreground/15"
                }`}
              aria-label={uploadsLocked ? t("view.unlockUploads") : t("view.lockUploads")}
              title={uploadsLocked ? t("view.uploadsLocked") : t("view.lockUploads")}
            >
              {uploadsLocked ? (
                <Lock size={14} strokeWidth={2.2} />
              ) : (
                <Unlock size={14} strokeWidth={2.2} />
              )}
            </button>
          )}

          {/* Toggle */}
          <button
            onClick={() => void handleAmbientToggle()}
            disabled={togglePending}
            className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-60 disabled:cursor-progress ${ambientOn ? "bg-foreground" : "bg-foreground/20"
              }`}
            aria-label={t("view.toggleAmbient")}
            aria-busy={togglePending}
          >
            <motion.span
              layout
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
              className={`absolute top-0.5 w-6 h-6 rounded-full bg-background shadow-sm ${ambientOn ? "left-[22px]" : "left-0.5"
                }`}
            />
          </button>
        </div>
      </div>

      {/* ── LIVE SESSION (only when ambient on + active) ── */}
      <AnimatePresence mode="wait">
        {liveSession && (
          <LiveSessionCard
            session={liveSession}
            previewVisibleCount={previewVisibleCount}
            variant="ambient"
            onFocus={onOpenFullscreen}
            onDismiss={dismissLiveSession}
          />
        )}
      </AnimatePresence>

      {/* ── Devices strip — clickable to manage ── */}
      <button
        onClick={handleConnectMore}
        className="w-full mb-5 text-left group"
        aria-label={t("view.manageConnectedDevices")}
      >
        <div className="glass-card p-2.5 flex items-center gap-2 transition-all group-hover:bg-foreground/[0.02]">
          <div className="flex items-center -space-x-1.5 flex-1">
            {visibleConnectedDevices.map((device) => {
              const Icon = iconForUserDevice(device.platform);
              return (
                <div
                  key={device.device_id}
                  title={titleForUserDevice(device)}
                  className="relative w-7 h-7 rounded-full bg-background border border-foreground/10 flex items-center justify-center text-foreground/80"
                >
                  <Icon size={13} strokeWidth={1.8} />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-background ${signalClassForUserDevice(device)
                      }`}
                  />
                </div>
              );
            })}
            <div className="relative w-7 h-7 rounded-full bg-foreground/5 border border-dashed border-foreground/25 flex items-center justify-center text-foreground/50">
              {hiddenDeviceCount > 0 ? (
                <Text variant="micro" weight="semibold" className="leading-none">+{hiddenDeviceCount}</Text>
              ) : (
                <Plus size={12} strokeWidth={2.2} />
              )}
            </div>
          </div>

          <div className="text-right pr-1 shrink-0">
            <Text variant="caption" weight="medium" className="block text-foreground/75 leading-tight">
              {deviceStripSummary(connectedCount, devicesLoading, devicesError, hiddenDeviceCount)}
            </Text>
            <p className="text-micro text-foreground/45 leading-tight mt-0.5 flex items-center gap-0.5 justify-end">
              {t("view.connectInControl")} <ChevronRight size={9} />
            </p>
          </div>
        </div>
      </button>

      {/* Web preview keeps the narrative mock; native uses the local timeline narrative. */}
      {(!useWebPreviewTimeline && ambientTimeline.narrativeSummary) && (
        <div
          className="mb-3 rounded-2xl p-4"
          style={{
            background: "linear-gradient(135deg, hsl(220 50% 98%), hsl(260 40% 97%))",
            border: "1px solid hsl(0 0% 100% / 0.5)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-micro font-bold tracking-[0.16em] flex items-center gap-1.5">
              <Sparkles size={11} className="text-[hsl(304_75%_55%)]" />
              <span className="text-[hsl(304_75%_45%)]">{t("view.todayLocalSummary")}</span>
            </p>
            <Text variant="micro" className="text-foreground/45 font-mono">{t("view.entries", { count: timelineEntries.length })}</Text>
          </div>
          <Text variant="bodySm" className="block leading-relaxed text-foreground/85">{ambientTimeline.narrativeSummary}</Text>
        </div>
      )}

      {isNative && ambientTimeline.pendingTranscriptCount > 0 && timelineEntries.length === 0 && (
        <AmbientModelRequiredCard onOpenSetup={() => setModelSetupOpen(true)} />
      )}

      {useWebPreviewTimeline && (
        <div
          className="mb-3 rounded-2xl p-4"
          style={{
            background: "linear-gradient(135deg, hsl(220 50% 98%), hsl(260 40% 97%))",
            border: "1px solid hsl(0 0% 100% / 0.5)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-micro font-bold tracking-[0.16em] flex items-center gap-1.5">
              <Sparkles size={11} className="text-[hsl(304_75%_55%)]" />
              <span className="text-[hsl(304_75%_45%)]">{t("view.todayNarrativeSummary")}</span>
            </p>
            <Text variant="micro" className="text-foreground/45 font-mono">{t("view.entries", { count: timelineEntries.length })}</Text>
          </div>
          <Text variant="bodySm" className="block leading-relaxed text-foreground/85">{t("demo.narrative")}</Text>
        </div>
      )}

      {/* ── Timeline ── */}
      <div className="space-y-2.5">
        {timelineEntries.length === 0 && (
          <div className="glass-card p-4 text-center">
            {ambientTimeline.loading && (
              <div className="mb-3 flex items-center justify-center gap-1.5" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-foreground/45"
                    animate={{ opacity: [0.35, 1, 0.35], y: [0, -3, 0] }}
                    transition={{
                      duration: 0.85,
                      repeat: Infinity,
                      delay: i * 0.12,
                      ease: "easeInOut",
                    }}
                  />
                ))}
              </div>
            )}
            <Text variant="bodySm" weight="semibold" className="block text-foreground/80">
              {ambientTimeline.loading ? t("view.buildingTimeline") : t("view.noTimelineEvents")}
            </Text>
            <Text variant="label" className="block mt-1 text-foreground/50 leading-snug">
              {ambientTimeline.error
                ? ambientTimeline.error
                : ambientOn
                  ? t("view.emptyKeepOn")
                  : t("view.emptyTurnOn")}
            </Text>
            {ambientTimeline.storeStatus?.lastError && (
              <Text variant="caption" className="block mt-2 text-red-500">
                {ambientTimeline.storeStatus.lastError}
              </Text>
            )}
          </div>
        )}
        {visibleTimelineEntries.map((entry, idx) => (
          <motion.div
            key={entry.id ?? entry.time + entry.title}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.04 }}
            className="glass-card p-3.5"
          >
            <div className="flex gap-3">
              {/* Lucide icon (B&W) */}
              <div className="w-10 h-10 rounded-xl bg-foreground/[0.04] border border-foreground/[0.06] flex items-center justify-center text-foreground/75 shrink-0">
                <entry.icon size={17} strokeWidth={1.7} />
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap text-caption">
                    <span className="font-semibold text-foreground/70">{entry.time}</span>
                    <span className="text-foreground/30">·</span>
                    <span className="inline-flex items-center gap-1 text-[hsl(304_75%_45%)] font-medium">
                      <entry.device.icon size={11} strokeWidth={2} />
                      {entry.device.name}
                    </span>
                    {entry.privacyTag === "private" && (
                      <>
                        <span className="text-foreground/30">·</span>
                        <span className="inline-flex items-center gap-0.5 text-[hsl(304_75%_55%)] font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-[hsl(304_75%_63%)]" />
                          {t("view.privateBadge")}
                        </span>
                      </>
                    )}
                    {entry.privacyTag === "sensitive" && (
                      <>
                        <span className="text-foreground/30">·</span>
                        <span className="inline-flex items-center gap-0.5 text-[hsl(304_75%_55%)] font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-[hsl(304_75%_63%)]" />
                          {t("view.sensitiveBadge")}
                        </span>
                      </>
                    )}
                    {entry.confidenceLabel === "uncertain" && (
                      <>
                        <span className="text-foreground/30">·</span>
                        <span className="inline-flex items-center gap-0.5 text-foreground/45 font-medium">
                          {t("view.uncertainBadge")}
                        </span>
                      </>
                    )}
                  </div>
                  {entry.onDismiss && (
                    <button
                      onClick={entry.onDismiss}
                      className="text-foreground/30 hover:text-foreground/60 shrink-0"
                      aria-label={t("view.dismissAria")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                <Text variant="bodySm" weight="semibold" className="block text-foreground leading-snug mt-1 mb-1">
                  {entry.title}
                </Text>
                <Text variant="bodySm" className="block text-foreground/65 leading-snug">{entry.body}</Text>

                {/* Tags */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {entry.tags.map((t) => (
                    <Text variant="micro"
                      key={t}
                      className="px-2 py-0.5 rounded-full bg-foreground/[0.05] text-foreground/55"
                    >
                      #{t}
                    </Text>
                  ))}
                </div>

                {/* Triggered NOW card — the "Open →" button is the
                    single Ambient → Action handoff: when the entry
                    carries an `action`, clicking it ships the event
                    into the existing CardChat → MainChatView SSE
                    runtime (cloud LLM). Entries without `action` keep
                    the historical decorative-only behaviour. */}
                {entry.triggeredCard && (
                  <div
                    className="mt-2.5 rounded-xl p-2.5"
                    style={{
                      background: "linear-gradient(135deg, hsl(304 75% 63% / 0.07), hsl(304 75% 63% / 0.02))",
                      border: "1px solid hsl(304 75% 63% / 0.18)",
                    }}
                  >
                    <p className="text-micro font-bold uppercase tracking-[0.14em] text-[hsl(304_75%_45%)] mb-1 flex items-center gap-1">
                      {t("view.triggeredThisCard")}
                    </p>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Sparkles size={11} className="text-[hsl(304_75%_55%)] shrink-0" />
                        <Text variant="label" className="text-foreground/85 truncate">
                          {entry.triggeredCard}
                        </Text>
                      </div>
                      <button
                        onClick={
                          entry.action && onAmbientAction
                            ? (e) => {
                              e.stopPropagation();
                              onAmbientAction(entry);
                            }
                            : undefined
                        }
                        className="text-caption font-semibold text-[hsl(304_75%_45%)] shrink-0 flex items-center gap-0.5 hover:text-[hsl(304_75%_35%)]"
                      >
                        {t("view.open")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        ))}
        {canLoadMoreTimelineEntries && (
          <button
            onClick={() => {
              setTimelineVisibleCount((count) => Math.min(
                count + TIMELINE_LOAD_MORE_COUNT,
                timelineEntries.length,
              ));
            }}
            className="w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.035] px-4 py-3 text-label font-semibold text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors"
          >
            {t("view.loadMore", { count: timelineEntries.length - visibleTimelineEntries.length })}
          </button>
        )}
      </div>

      {/* Bottom hint */}
      <div className="mt-5 flex items-center justify-center gap-1.5 text-micro text-foreground/40">
        <Lightbulb size={10} />
        <span>
          {ambientOn
            ? t("view.hintLiveAssist")
            : t("view.hintEnableAssist")}
        </span>
      </div>

      <AnimatePresence>
        {modelSetupOpen && (
          <motion.div
            className="fixed inset-0 z-[90] flex items-end bg-black/30 px-3 pb-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-label={t("view.modelSetupAria")}
          >
            <motion.div
              className="w-full rounded-3xl bg-background p-3 shadow-2xl"
              initial={{ y: 40 }}
              animate={{ y: 0 }}
              exit={{ y: 40 }}
            >
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setModelSetupOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground/60"
                  aria-label={t("view.closeModelSetupAria")}
                >
                  <X size={14} />
                </button>
              </div>
              <AmbientModelSetupStep compact />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen overlay is owned by parent (AppLayout) so it survives view changes. */}
    </div>
  );
}

/* ──────────────── FULLSCREEN LIVE OVERLAY ──────────────── */

export const LiveFullscreen = forwardRef<HTMLDivElement, {
  session: LiveSession;
  onClose: () => void;
}>(function LiveFullscreen({ session, onClose }, ref) {
  const { t } = useTranslation("ambient");
  const [elapsed, setElapsed] = useState(0);
  const [isFollowingLive, setIsFollowingLive] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldFollowLiveRef = useRef(true);
  const previousAssistCount = useRef(session.assists.length);
  const previousAssistKeys = useRef(new Set(session.assists.map(liveAssistKey)));
  const [animatedAssistKeys, setAnimatedAssistKeys] = useState<Set<string>>(() => new Set());

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    shouldFollowLiveRef.current = true;
    setIsFollowingLive(true);
    setUnseenCount(0);
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  useLayoutEffect(() => {
    previousAssistCount.current = session.assists.length;
    previousAssistKeys.current = new Set(session.assists.map(liveAssistKey));
    setAnimatedAssistKeys(new Set());
    scrollMessagesToBottom("auto");
  }, [scrollMessagesToBottom, session.startedAt]);

  useEffect(() => {
    const previous = previousAssistCount.current;
    previousAssistCount.current = session.assists.length;
    const previousKeys = previousAssistKeys.current;
    const currentKeys = new Set(session.assists.map(liveAssistKey));
    previousAssistKeys.current = currentKeys;
    const addedKeys = session.assists
      .map(liveAssistKey)
      .filter((key) => !previousKeys.has(key));
    if (session.assists.length <= previous || addedKeys.length === 0) return;
    setAnimatedAssistKeys((keys) => new Set([...keys, ...addedKeys]));
    const added = addedKeys.length;
    if (shouldFollowLiveRef.current) {
      requestAnimationFrame(() => scrollMessagesToBottom("smooth"));
      return;
    }
    setUnseenCount((count) => count + added);
  }, [scrollMessagesToBottom, session.assists.length]);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const atBottom = isNearScrollBottom(el);
    shouldFollowLiveRef.current = atBottom;
    setIsFollowingLive(atBottom);
    if (atBottom) setUnseenCount(0);
  }, []);

  const handleAssistRowAnimationComplete = useCallback((key: string) => {
    setAnimatedAssistKeys((keys) => {
      if (!keys.has(key)) return keys;
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };

  const SessionIcon = session.icon;
  const visibleCount = session.assists.length;
  const visible = session.assists;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[100] flex flex-col"
      style={{
        background: "hsl(0 0% 4%)",
        color: "hsl(0 0% 96%)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t("live.focusModeAria")}
    >
      {/* Pink halo backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 50% at 50% 0%, hsl(304 75% 50% / 0.22) 0%, hsl(304 75% 50% / 0.06) 35%, transparent 70%)",
        }}
      />

      {/* Top bar — solid backdrop so it stays readable */}
      <div
        className="relative flex items-center justify-between px-5 border-b border-white/[0.08]"
        style={{
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)",
          paddingBottom: "14px",
          background: "hsl(0 0% 4% / 0.85)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="relative flex w-2.5 h-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[hsl(304_75%_70%)] opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[hsl(304_75%_70%)]" />
          </span>
          <Text variant="caption" weight="bold" className="uppercase tracking-[0.22em] text-[hsl(304_75%_78%)] truncate">
            {t("live.label", { kind: session.kind })}
          </Text>
          <Text variant="caption" className="tabular-nums text-white/55 font-mono ml-1.5 shrink-0">
            {fmt(elapsed)}
          </Text>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 px-3.5 h-9 rounded-full text-bodySm font-medium text-white/85 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors flex items-center gap-1.5"
          aria-label={t("live.exitFullscreenAria")}
        >
          <Minimize2 size={14} strokeWidth={2.2} />
          {t("live.exit")}
        </button>
      </div>

      {/* Compact session header */}
      <div className="relative px-5 md:px-12 pt-4 pb-3 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white/85 shrink-0">
            <SessionIcon size={16} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-body font-semibold leading-tight tracking-tight truncate">
              {session.title}
            </h2>
            <p className="mt-0.5 text-caption text-white/50 flex items-center gap-1 truncate">
              <MapPin size={10} className="shrink-0" />
              <span className="truncate">{session.location}</span>
              <span className="text-white/30">·</span>
              <span className="truncate">{session.device}</span>
            </p>
          </div>
        </div>

        {/* Signals — single horizontal scroll row */}
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto scrollbar-none -mx-5 px-5 md:mx-0 md:px-0">
          {session.signals.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.05] text-micro text-white/65 border border-white/[0.06] whitespace-nowrap shrink-0"
            >
              <Mic size={9} strokeWidth={2} />
              {s}
            </span>
          ))}
        </div>
      </div>

      {/* Divider with "REAL-TIME ASSIST" label */}
      <div className="relative px-5 md:px-12 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-2.5 py-2.5 border-y border-white/[0.06]">
          <Sparkles size={11} className="text-[hsl(304_75%_75%)]" />
          <Text variant="micro" weight="bold" className="uppercase tracking-[0.22em] text-[hsl(304_75%_75%)]">
            {t("live.realTimeAssist")}
          </Text>
          <Text variant="micro" className="ml-auto text-white/40 font-mono tabular-nums">
            {visibleCount}/{session.assists.length}
          </Text>
        </div>
      </div>

      {/* Streaming assist messages — scrollable history with bottom-follow when live. */}
      <div className="relative flex-1 overflow-hidden px-5 md:px-12 pb-20">
        <div
          ref={messagesRef}
          onScroll={handleMessagesScroll}
          data-testid="live-fullscreen-messages"
          className="relative z-0 max-w-3xl mx-auto w-full h-full overflow-y-auto overscroll-contain scrollbar-none pr-1"
          style={{
            WebkitMaskImage: LIVE_FULLSCREEN_VIEWPORT_FADE_MASK,
            maskImage: LIVE_FULLSCREEN_VIEWPORT_FADE_MASK,
          }}
        >
          <div className="min-h-full flex flex-col justify-end gap-4 pt-24 pb-8">
            <AnimatePresence initial={false} mode="popLayout">
              {visible.map((a, idx) => (
                <LiveFullscreenAssistRow
                  key={liveAssistKey(a)}
                  assist={a}
                  isNewest={idx === visible.length - 1}
                  animated={animatedAssistKeys.has(liveAssistKey(a))}
                  onAnimationComplete={handleAssistRowAnimationComplete}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>

        <AnimatePresence>
          {!isFollowingLive && unseenCount > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center">
              <motion.button
                type="button"
                onClick={() => scrollMessagesToBottom("smooth")}
                initial={{ opacity: 0, y: 12, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[hsl(304_75%_70%/0.35)] bg-[hsl(0_0%_4%/0.88)] px-3 py-2 text-label font-semibold text-[hsl(304_75%_82%)] shadow-lg backdrop-blur-md"
                aria-label={t("live.newMessagesAria", { count: unseenCount })}
              >
                <ChevronDown size={14} strokeWidth={2.2} />
                <span>{t("live.newCount", { count: unseenCount })}</span>
              </motion.button>
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom footer */}
      <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-white/[0.06] bg-black/40 backdrop-blur-md">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-caption text-white/45">
          <span className="flex items-center gap-1.5">
            <Lightbulb size={11} /> {t("live.footerHint")}
          </span>
          <span className="hidden md:inline">{t("live.pressEsc")}</span>
        </div>
      </div>
    </motion.div>
  );
});

interface LiveFullscreenAssistRowProps {
  assist: LiveAssistItem;
  isNewest: boolean;
  animated: boolean;
  onAnimationComplete: (key: string) => void;
}

function LiveFullscreenAssistRow({
  assist,
  isNewest,
  animated,
  onAnimationComplete,
}: LiveFullscreenAssistRowProps) {
  const { t } = useTranslation("ambient");
  const key = liveAssistKey(assist);
  const content = (
    <>
      <span
        className={`text-caption font-mono pt-1 w-14 shrink-0 tabular-nums transition-colors duration-500 ${isNewest ? "text-[hsl(304_75%_70%)]" : "text-white/30"
          }`}
      >
        {assist.time}
      </span>
      <div className="min-w-0 flex-1">
        {assist.kind === "action" && (
          <Text variant="micro" weight="bold" className="inline-block mb-1.5 px-1.5 py-0.5 rounded uppercase tracking-wider bg-[hsl(304_75%_63%)] text-white">
            {t("live.actionBadge")}
          </Text>
        )}
        <p
          className={`leading-snug transition-colors duration-500 ${assist.kind === "action"
            ? "text-white text-subheading md:text-heading font-medium"
            : assist.kind === "assist"
              ? "text-white/90 text-subheading md:text-heading"
              : "text-white/75 text-body md:text-subheading"
            }`}
        >
          {assist.text}
        </p>
        {assist.source && (
          <Text variant="caption" className="block text-white/40 mt-1">{t("live.viaSource", { source: assist.source })}</Text>
        )}
      </div>
    </>
  );

  if (animated) {
    return (
      <motion.div
        layout
        data-testid="live-fullscreen-assist-row"
        data-live-animated="true"
        onAnimationComplete={() => onAnimationComplete(key)}
        initial={{
          opacity: 0,
          y: 36,
          filter: "blur(6px)",
          scale: 0.96,
        }}
        animate={{
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          scale: 1,
        }}
        exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
        transition={{
          opacity: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
          y: { type: "spring", stiffness: 320, damping: 32, mass: 0.7 },
          filter: { duration: 0.4, ease: "easeOut" },
          scale: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
          layout: { type: "spring", stiffness: 320, damping: 34, mass: 0.7 },
        }}
        className="flex gap-3"
      >
        {content}
      </motion.div>
    );
  }

  return (
    <div data-testid="live-fullscreen-assist-row" className="flex gap-3">
      {content}
    </div>
  );
}

function liveAssistKey(assist: LiveAssistItem): string {
  return `${assist.time}:${assist.text}`;
}

function isNearScrollBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 64;
}
