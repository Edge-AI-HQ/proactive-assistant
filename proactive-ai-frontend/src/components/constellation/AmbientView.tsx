import { useState, useEffect, useCallback, useMemo, useRef, forwardRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { isNative } from "@/lib/platform";
import {
  Radio, Smartphone, Watch, Laptop,
  MapPin, Compass, Mic, Activity, Wifi,
  Stethoscope,
  Lightbulb, Sparkles, Plus, ChevronRight, X,
  Phone, Sun, Waves, Target,
  Soup, Minimize2, Lock, Unlock, Zap,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useUserDevices } from "@/hooks/useUserDevices";
import { useAmbientTimeline } from "@/hooks/useAmbientTimeline";
import { useAmbientLiveSession } from "@/hooks/useAmbientLiveSession";
import LiveSessionCard from "./LiveSessionCard";
import { ALL_SOURCE_KEYS, type SourceKey } from "@/services/ambient/keys";
import {
  getPersistedAmbientEnabled,
  setPersistedAmbientEnabled,
} from "@/services/ambient/enabled-state";
import type {
  AmbientCandidateWindow,
  AmbientPrivacy,
  AmbientRawEvent,
  AmbientSourceType,
  AmbientTimelineEvent,
} from "@/services/ambient/timeline";
import type { RuntimeStatus } from "@/services/ambient";
import type { LiveSession } from "@/services/ambient/live-session";
import type { UserDevice, UserDevicePlatform } from "@/lib/api";

/* ──────────────── TIMELINE (today's narrative) ──────────────── */

export interface AmbientTimelineAction {
  label: string;
  goal: string;
  goalBasket?: "work" | "health" | "family" | "wealth" | "growth" | "life";
}

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

const TIMELINE: TimelineEntry[] = [
  {
    time: "9:12 AM",
    icon: Sun,
    device: { name: "Apple Watch", icon: Watch },
    title: "Morning — well-rested and on-time",
    body: "Slept 7h 24m (HRV 62, +4 above baseline). Commuted via Muni, arrived WeWork 9:12. No blocked meetings.",
    tags: ["sleep", "commute"],
  },
  {
    id: "t-investor",
    time: "10:03 AM",
    icon: Phone,
    device: { name: "MacBook", icon: Laptop },
    privacyTag: "private",
    title: "Investor call — Sequoia (Mike K.)",
    body: "45-min call. Discussed Series A bridge. HR elevated during term-sheet discussion (158 peak). Action items: send updated cap table.",
    tags: ["work", "call"],
    triggeredCard: "C1 Fund SAFE Conversion …",
    action: {
      label: "Send recap to Mike",
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
    title: "Lunch at Souvla with Priya",
    body: "Discussed weekend Tahoe trip. Priya mentioned her sister's wedding in June — calendar hold queued.",
    tags: ["life", "social"],
    action: {
      label: "Hold June wedding date",
      goal: "Add a tentative calendar hold for Priya's sister's wedding in June and remind me to confirm the exact date with Priya.",
      goalBasket: "life",
    },
  },
  {
    time: "1:15 PM",
    icon: Target,
    device: { name: "MacBook", icon: Laptop },
    title: "45-min deep focus block",
    body: "No Slack, zero tab switches. Drafted Q3 hiring plan. Flow state window identified.",
    tags: ["focus", "work"],
    triggeredCard: "Daily Reflection — Monday",
  },
  {
    time: "2:30 PM",
    icon: MapPin,
    device: { name: "iPhone", icon: Smartphone },
    title: "Context shift — WeWork → Home",
    body: "Commute detected via motion + location. Re-ranked feed: Work cards deferred, Life cards surfaced.",
    tags: ["transition"],
    triggeredCard: "Context Shift — Arrived at …",
  },
  {
    time: "4:45 PM",
    icon: Waves,
    device: { name: "Apple Watch", icon: Watch },
    title: "Swim session at Mission Pool",
    body: "40 laps freestyle. HR zone 3 for 32 minutes. 8% above weekly average.",
    tags: ["health", "fitness"],
  },
];

const NARRATIVE_SUMMARY =
  "Today felt productive. 7h 24m of sleep set a clean baseline; you ran hot during the Sequoia call (HR peaked at 158) but recovered in the 45-min focus block after lunch. Evening swim hit zone 3 for 32 minutes — 8% above your weekly average. Dad is visiting and mentioned a cardiologist appointment Thursday.";

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
  if (isLlmSummaryEvent(event)) return "On-device summary";
  return event.primarySourceLabel;
}

function timelineEventToEntry(
  event: AmbientTimelineEvent,
  onDismiss: (id: string) => void,
): TimelineEntry {
  const parsedTs = Date.parse(event.occurredAt);
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
    triggeredCard: event.triggeredCardTitle,
    onDismiss: () => onDismiss(event.id),
  };
}

function pendingTranscriptWindowToEntry(window: AmbientCandidateWindow): TimelineEntry {
  return {
    id: `pending-${window.id}`,
    sortTs: Date.parse(window.startedAt),
    time: formatTimelineTime(window.startedAt),
    icon: Mic,
    device: { name: "Microphone", icon: Mic },
    privacyTag: "private",
    confidenceLabel: window.confidenceHint >= 0.65 ? "certain" : "uncertain",
    title: "Voice transcript pending",
    body: transcriptWindowPreview(window.compactContext),
    tags: ["voice", "pending"],
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
  if (sourceType === "location") return MapPin;
  if (sourceType === "motion") return Activity;
  if (sourceType === "sound") return Waves;
  if (sourceType === "visit") return MapPin;
  if (sourceType === "calendar") return Target;
  return Sparkles;
}

function deviceIconForRawEvent(sourceType: AmbientSourceType): LucideIcon {
  if (sourceType === "health") return Watch;
  if (sourceType === "motion") return Activity;
  if (sourceType === "sound") return Mic;
  if (sourceType === "visit") return MapPin;
  if (sourceType === "calendar") return Smartphone;
  return Smartphone;
}

function deviceLabelForRawEvent(raw: AmbientRawEvent): string {
  if (raw.sourceType === "health") return "HealthKit";
  if (raw.sourceType === "location") return "Location";
  if (raw.sourceType === "motion") return "Motion";
  if (raw.sourceType === "sound") return "Microphone";
  if (raw.sourceType === "visit") return "Places";
  if (raw.sourceType === "calendar") return "Calendar";
  return raw.sourceType;
}

function titleForRawEvent(sourceType: AmbientSourceType): string {
  if (sourceType === "health") return "Health update";
  if (sourceType === "location") return "Location updated";
  if (sourceType === "motion") return "Motion update";
  if (sourceType === "sound") return "Sound context";
  if (sourceType === "visit") return "Place update";
  if (sourceType === "calendar") return "Calendar context";
  return "Context update";
}

function tagsForRawEvent(raw: AmbientRawEvent): string[] {
  if (raw.sourceType === "health") return ["health", "latest"];
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
  if (raw.sourceType === "sound") {
    return soundBody(raw.compactText);
  }
  return raw.compactText || `${titleForRawEvent(raw.sourceType)} captured.`;
}

function soundBody(text: string): string {
  const match = /^Heard\s+([a-zA-Z_ -]+?)\s+for\s+/.exec(text.trim());
  const label = match?.[1]?.trim().toLowerCase();
  if (label === "speech" || label === "conversation") return "Speech detected";
  if (label === "traffic") return "Traffic sound";
  if (label === "quiet" || label === "quiet room") return "Quiet room";
  if (label === "music" || label === "singing") return "Music";
  return "Sound detected";
}

function transcriptWindowPreview(compactContext: string): string {
  const segments = compactContext
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
    device.app_version ? `app ${device.app_version}` : null,
    device.last_seen_at ? `last seen ${formatDeviceRelativeTime(device.last_seen_at)}` : null,
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
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

function deviceStripSummary(
  connectedCount: number,
  loading: boolean,
  error: string | null,
  hiddenDeviceCount: number,
): string {
  if (loading && connectedCount === 0) return "Loading devices";
  if (error && connectedCount === 0) return "Devices unavailable";
  if (hiddenDeviceCount > 0) return `${hiddenDeviceCount} more connected`;
  if (connectedCount > 0) return "Manage devices";
  return "No devices paired";
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
  const { settings, patch } = useUserSettings();
  const { devices, loading: devicesLoading, error: devicesError } = useUserDevices(true);
  const ambientTimeline = useAmbientTimeline();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [persistedAmbientOn, setPersistedAmbientOn] = useState(() =>
    getPersistedAmbientEnabled(),
  );
  const [togglePending, setTogglePending] = useState(false);
  const [timelineVisibleCount, setTimelineVisibleCount] = useState(INITIAL_TIMELINE_VISIBLE_COUNT);
  const connectedDevices = useMemo(
    () => devices.filter((d) => d.status === "active" && d.platform !== "web"),
    [devices],
  );
  const visibleConnectedDevices = connectedDevices.slice(0, 5);
  const connectedCount = connectedDevices.length;
  const hiddenDeviceCount = Math.max(0, connectedCount - visibleConnectedDevices.length);
  const deviceCountLabel = devicesLoading && connectedCount === 0
    ? "Loading devices"
    : devicesError && connectedCount === 0
      ? "devices unavailable"
      : `${connectedCount} ${connectedCount === 1 ? "device" : "devices"}`;

  // Reflect server-side consent first; fall back to live runtime state
  // before settings hydrate so the hero doesn't flicker on mount.
  const consentOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : null;
  const runtimeOn = runtimeStatus
    ? runtimeStatus.sources.some((s) => s.enabled)
    : false;
  const ambientOn = persistedAmbientOn || (consentOn ?? runtimeOn);
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
        const { getAmbientRuntime } = await import("@/services/ambient");
        if (cancelled) return;
        const rt = getAmbientRuntime();
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
  }, []);

  const handleAmbientToggle = useCallback(async () => {
    if (togglePending) return;
    const next = !ambientOn;
    setTogglePending(true);
    try {
      const consentPatch = Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: next }]),
      );
      const updated = await patch({ ambientSources: consentPatch });
      setPersistedAmbientEnabled(next);
      setPersistedAmbientOn(next);
      if (!isNative) return;
      const lifecycle = await import("@/services/ambient/lifecycle");
      if (next) {
        const enabledSources = updated
          ? (Object.entries(updated.ambientSources ?? {})
            .filter(([, v]) => v?.enabled === true)
            .map(([k]) => k as SourceKey))
          : ALL_SOURCE_KEYS;
        lifecycle.startAmbientUpload({
          enabledSources: enabledSources.length > 0 ? enabledSources : ALL_SOURCE_KEYS,
          transcriptionLanguage: updated?.generationLanguage ?? settings?.generationLanguage ?? null,
        });
      } else {
        await lifecycle.stopAmbientUpload();
      }
    } finally {
      setTogglePending(false);
    }
  }, [ambientOn, patch, settings?.generationLanguage, togglePending]);

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
    if (useWebPreviewTimeline) return TIMELINE;
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
      className="h-full overflow-y-auto pb-32 px-4"
      style={{ paddingTop: "calc(0.875rem + env(safe-area-inset-top, 0px))" }}
    >
      {/* ── Header ── */}
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight leading-tight">
          Ambient
        </h1>
        <div className="mt-1 flex items-center gap-1.5 text-[13px] text-foreground/60">
          <span>{deviceCountLabel}</span>
          <span className="text-foreground/30">·</span>
          <span>on-device TEE</span>
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
            <p className="text-[14px] font-semibold text-foreground leading-tight">
              Ambient is {ambientOn ? "on" : "off"}
            </p>
            <p className="text-[11px] text-foreground/55 leading-tight mt-0.5 truncate">
              {!ambientOn
                ? "AI is paused from sensing your surroundings"
                : uploadsLocked
                  ? "Sensing locally — uploads paused"
                  : firstSourceError
                    ? firstSourceError
                    : "Listening, sensing, understanding context"}
            </p>
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
              aria-label={uploadsLocked ? "Unlock uploads" : "Lock uploads"}
              title={uploadsLocked ? "Uploads locked" : "Lock uploads"}
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
            aria-label="Toggle ambient"
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
        aria-label="Manage connected devices"
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
                <span className="text-[9px] font-semibold leading-none">+{hiddenDeviceCount}</span>
              ) : (
                <Plus size={12} strokeWidth={2.2} />
              )}
            </div>
          </div>

          <div className="text-right pr-1 shrink-0">
            <p className="text-[11px] font-medium text-foreground/75 leading-tight">
              {deviceStripSummary(connectedCount, devicesLoading, devicesError, hiddenDeviceCount)}
            </p>
            <p className="text-[9px] text-foreground/45 leading-tight mt-0.5 flex items-center gap-0.5 justify-end">
              Connect in Control <ChevronRight size={9} />
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
            <p className="text-[10px] font-bold tracking-[0.16em] flex items-center gap-1.5">
              <Sparkles size={11} className="text-[hsl(304_75%_55%)]" />
              <span className="text-[hsl(304_75%_45%)]">TODAY · LOCAL SUMMARY</span>
            </p>
            <span className="text-[10px] text-foreground/45 font-mono">{timelineEntries.length} entries</span>
          </div>
          <p className="text-[13px] leading-relaxed text-foreground/85">{ambientTimeline.narrativeSummary}</p>
        </div>
      )}

      {isNative && ambientTimeline.pendingTranscriptCount > 0 && timelineEntries.length === 0 && (
        <div className="mb-3 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-4">
          <p className="text-[12px] font-semibold text-foreground/80">Local summaries are waiting for a verified LLM.</p>
          <p className="mt-1 text-[11px] text-foreground/50 leading-snug">
            {ambientTimeline.pendingTranscriptCount} transcript window{ambientTimeline.pendingTranscriptCount === 1 ? "" : "s"} pending. Open Ambient Models and choose Use for local summaries after verification.
          </p>
        </div>
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
            <p className="text-[10px] font-bold tracking-[0.16em] flex items-center gap-1.5">
              <Sparkles size={11} className="text-[hsl(304_75%_55%)]" />
              <span className="text-[hsl(304_75%_45%)]">TODAY · NARRATIVE SUMMARY</span>
            </p>
            <span className="text-[10px] text-foreground/45 font-mono">{timelineEntries.length} entries</span>
          </div>
          <p className="text-[13px] leading-relaxed text-foreground/85">{NARRATIVE_SUMMARY}</p>
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
            <p className="text-[13px] font-semibold text-foreground/80">
              {ambientTimeline.loading ? "Building local timeline…" : "No local timeline events yet"}
            </p>
            <p className="mt-1 text-[12px] text-foreground/50 leading-snug">
              {ambientTimeline.error
                ? ambientTimeline.error
                : ambientOn
                  ? "Keep Ambient on while Visit, Location, Motion, and Health collect real signals."
                  : "Turn Ambient on to create timeline events from local signals."}
            </p>
            {ambientTimeline.storeStatus?.lastError && (
              <p className="mt-2 text-[11px] text-red-500">
                {ambientTimeline.storeStatus.lastError}
              </p>
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
                  <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
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
                          private
                        </span>
                      </>
                    )}
                    {entry.privacyTag === "sensitive" && (
                      <>
                        <span className="text-foreground/30">·</span>
                        <span className="inline-flex items-center gap-0.5 text-[hsl(304_75%_55%)] font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-[hsl(304_75%_63%)]" />
                          sensitive
                        </span>
                      </>
                    )}
                    {entry.confidenceLabel === "uncertain" && (
                      <>
                        <span className="text-foreground/30">·</span>
                        <span className="inline-flex items-center gap-0.5 text-foreground/45 font-medium">
                          uncertain
                        </span>
                      </>
                    )}
                  </div>
                  {entry.onDismiss && (
                    <button
                      onClick={entry.onDismiss}
                      className="text-foreground/30 hover:text-foreground/60 shrink-0"
                      aria-label="Dismiss"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                <p className="text-[13.5px] font-semibold text-foreground leading-snug mt-1 mb-1">
                  {entry.title}
                </p>
                <p className="text-[12.5px] text-foreground/65 leading-snug">{entry.body}</p>

                {/* Tags */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {entry.tags.map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 rounded-full bg-foreground/[0.05] text-[10px] text-foreground/55"
                    >
                      #{t}
                    </span>
                  ))}
                </div>

                {/* Action chip — hands the event off to the existing
                    CardChat → MainChatView SSE runtime. Only rendered when
                    the entry carries an `action` (mock timeline today; B
                    milestone wires real on-device LLM action candidates). */}
                {entry.action && onAmbientAction && (
                  <div className="mt-2.5 flex justify-end">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAmbientAction(entry);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-foreground text-background text-[11.5px] font-semibold hover:bg-foreground/85 transition-colors"
                    >
                      <Zap size={11} strokeWidth={2.2} />
                      {entry.action.label}
                    </button>
                  </div>
                )}

                {/* Triggered NOW card */}
                {entry.triggeredCard && (
                  <div
                    className="mt-2.5 rounded-xl p-2.5"
                    style={{
                      background: "linear-gradient(135deg, hsl(304 75% 63% / 0.07), hsl(304 75% 63% / 0.02))",
                      border: "1px solid hsl(304 75% 63% / 0.18)",
                    }}
                  >
                    <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[hsl(304_75%_45%)] mb-1 flex items-center gap-1">
                      → Triggered this card
                    </p>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Sparkles size={11} className="text-[hsl(304_75%_55%)] shrink-0" />
                        <span className="text-[12px] text-foreground/85 truncate">
                          {entry.triggeredCard}
                        </span>
                      </div>
                      <button className="text-[11px] font-semibold text-[hsl(304_75%_45%)] shrink-0 flex items-center gap-0.5 hover:text-[hsl(304_75%_35%)]">
                        Open →
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
            className="w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.035] px-4 py-3 text-[12px] font-semibold text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors"
          >
            Load more · {timelineEntries.length - visibleTimelineEntries.length} older
          </button>
        )}
      </div>

      {/* Bottom hint */}
      <div className="mt-5 flex items-center justify-center gap-1.5 text-[10px] text-foreground/40">
        <Lightbulb size={10} />
        <span>
          {ambientOn
            ? "Live assist appears whenever a real-world session is detected"
            : "Turn ambient on to enable real-time assist during meetings, visits, conversations"}
        </span>
      </div>

      {/* Fullscreen overlay is owned by parent (ConstellationLayout) so it survives view changes. */}
    </div>
  );
}

/* ──────────────── FULLSCREEN LIVE OVERLAY ──────────────── */

export const LiveFullscreen = forwardRef<HTMLDivElement, {
  session: LiveSession;
  onClose: () => void;
}>(function LiveFullscreen({ session, onClose }, ref) {
  // Progressively reveal assist messages, one at a time
  const [visibleCount, setVisibleCount] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const previousAssistCount = useRef(session.assists.length);

  useEffect(() => {
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (visibleCount >= session.assists.length) return;
    const t = setTimeout(() => setVisibleCount((c) => c + 1), 2000);
    return () => clearTimeout(t);
  }, [visibleCount, session.assists.length]);

  useEffect(() => {
    const previous = previousAssistCount.current;
    previousAssistCount.current = session.assists.length;
    if (session.assists.length <= previous) {
      setVisibleCount((count) => Math.min(count, session.assists.length));
      return;
    }
    setVisibleCount((count) => (
      count >= previous ? session.assists.length : count
    ));
  }, [session.assists.length]);

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
  const visible = session.assists.slice(0, visibleCount);

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
      aria-label="Live session focus mode"
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
          <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-[hsl(304_75%_78%)] truncate">
            Live · {session.kind}
          </span>
          <span className="text-[11px] tabular-nums text-white/55 font-mono ml-1.5 shrink-0">
            {fmt(elapsed)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 px-3.5 h-9 rounded-full text-[13px] font-medium text-white/85 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors flex items-center gap-1.5"
          aria-label="Exit fullscreen"
        >
          <Minimize2 size={14} strokeWidth={2.2} />
          Exit
        </button>
      </div>

      {/* Compact session header */}
      <div className="relative px-5 md:px-12 pt-4 pb-3 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white/85 shrink-0">
            <SessionIcon size={16} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight truncate">
              {session.title}
            </h2>
            <p className="mt-0.5 text-[11px] text-white/50 flex items-center gap-1 truncate">
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
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.05] text-[10px] text-white/65 border border-white/[0.06] whitespace-nowrap shrink-0"
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
          <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[hsl(304_75%_75%)]">
            Real-time assist
          </span>
          <span className="ml-auto text-[10px] text-white/40 font-mono tabular-nums">
            {visibleCount}/{session.assists.length}
          </span>
        </div>
      </div>

      {/* Streaming assist messages — livestream-style: newest slides up from bottom */}
      <div className="relative flex-1 overflow-hidden px-5 md:px-12 pb-32">
        {/* top fade mask so older messages dissolve out */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 z-10"
          style={{
            background:
              "linear-gradient(to bottom, hsl(0 0% 4%) 0%, hsl(0 0% 4% / 0.85) 40%, transparent 100%)",
          }}
        />

        <div className="max-w-3xl mx-auto w-full h-full flex flex-col justify-end">
          <div className="flex flex-col gap-4">
            <AnimatePresence initial={false} mode="popLayout">
              {visible.map((a, idx) => {
                const total = visible.length;
                const fromBottom = total - 1 - idx; // 0 = newest at bottom
                const isNewest = fromBottom === 0;
                // Older messages fade as they get pushed up
                const ageOpacity =
                  fromBottom === 0
                    ? 1
                    : fromBottom === 1
                      ? 0.88
                      : fromBottom === 2
                        ? 0.7
                        : fromBottom === 3
                          ? 0.5
                          : fromBottom === 4
                            ? 0.32
                            : 0.18;
                return (
                  <motion.div
                    key={a.time + a.text}
                    layout
                    initial={{
                      opacity: 0,
                      y: 36,
                      filter: "blur(6px)",
                      scale: 0.96,
                    }}
                    animate={{
                      opacity: ageOpacity,
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
                    <span
                      className={`text-[11px] font-mono pt-1 w-14 shrink-0 tabular-nums transition-colors duration-500 ${isNewest ? "text-[hsl(304_75%_70%)]" : "text-white/30"
                        }`}
                    >
                      {a.time}
                    </span>
                    <div className="min-w-0 flex-1">
                      {a.kind === "action" && (
                        <span className="inline-block mb-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-[hsl(304_75%_63%)] text-white">
                          Action
                        </span>
                      )}
                      <p
                        className={`leading-snug transition-colors duration-500 ${a.kind === "action"
                            ? "text-white text-[18px] md:text-[20px] font-medium"
                            : a.kind === "assist"
                              ? "text-white/90 text-[17px] md:text-[19px]"
                              : "text-white/75 text-[16px] md:text-[18px]"
                          }`}
                      >
                        {a.text}
                      </p>
                      {a.source && (
                        <p className="text-[11px] text-white/40 mt-1">via {a.source}</p>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {/* Typing indicator pinned at the bottom — next message arriving */}
            {visibleCount < session.assists.length && (
              <motion.div
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className="flex items-center gap-2 pt-1"
              >
                <span className="text-[10px] font-mono text-[hsl(304_75%_70%)] w-14 shrink-0">
                  live
                </span>
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[hsl(304_75%_70%)] animate-pulse" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[hsl(304_75%_70%)] animate-pulse [animation-delay:200ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[hsl(304_75%_70%)] animate-pulse [animation-delay:400ms]" />
                </span>
                <span className="text-[11px] text-white/45 italic">listening…</span>
              </motion.div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom footer */}
      <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-white/[0.06] bg-black/40 backdrop-blur-md">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-[11px] text-white/45">
          <span className="flex items-center gap-1.5">
            <Lightbulb size={11} /> Focus mode · messages stream as they happen
          </span>
          <span className="hidden md:inline">Press Esc to exit</span>
        </div>
      </div>
    </motion.div>
  );
});
