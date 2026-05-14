import { useState, useEffect, useCallback, forwardRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Radio, Smartphone, Watch, Glasses, Headphones, Camera, Laptop,
  MapPin, Compass, Mic, Activity, Wifi,
  Briefcase, Stethoscope, Coffee, BookOpen, Music,
  Lightbulb, Sparkles, Clock, Plus, ChevronRight, X,
  Phone, Footprints, Sun, Waves, UtensilsCrossed, Target,
  Users, Pill, Soup, Minimize2, Expand, Lock, Unlock,
  type LucideIcon,
} from "lucide-react";
import { useUserSettings } from "@/hooks/useUserSettings";
import {
  ALL_SOURCE_KEYS,
  getAmbientRuntime,
  type RuntimeStatus,
  type SourceKey,
} from "@/services/ambient";
import {
  startAmbientUpload,
  stopAmbientUpload,
} from "@/services/ambient/lifecycle";


interface Device {
  name: string;
  detail: string;
  icon: LucideIcon;
  connected: boolean;
  signal?: string;
}

const DEVICES: Device[] = [
  { name: "iPhone 15 Pro", detail: "Location · Motion · Audio", icon: Smartphone, connected: true, signal: "strong" },
  { name: "Apple Watch Ultra", detail: "Heart · Activity · Haptics", icon: Watch, connected: true, signal: "strong" },
  { name: "AirPods Pro", detail: "Ambient audio · Voice", icon: Headphones, connected: true, signal: "strong" },
  { name: "Ray-Ban Meta", detail: "Vision · POV capture", icon: Glasses, connected: true, signal: "weak" },
  { name: "Tesla Model 3", detail: "Driving · Location", icon: Compass, connected: false },
  { name: "Insta360", detail: "Spatial capture", icon: Camera, connected: false },
];

/* ──────────────── LIVE SESSION ──────────────── */

interface LiveAssistItem {
  time: string; // elapsed marker
  kind: "context" | "assist" | "action";
  text: string;
  source?: string;
}

export interface LiveSession {
  icon: LucideIcon;
  kind: string; // e.g. "Meeting", "Medical visit"
  title: string;
  location: string;
  device: string;
  startedAt: string; // human readable
  signals: string[]; // chips
  assists: LiveAssistItem[];
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

/* ──────────────── TIMELINE (today's narrative) ──────────────── */

interface TimelineEntry {
  time: string;
  icon: LucideIcon;
  device: { name: string; icon: LucideIcon };
  privacyTag?: "private";
  title: string;
  body: string;
  tags: string[];
  triggeredCard?: string; // ID/name of card it triggered in NOW feed
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
    time: "10:03 AM",
    icon: Phone,
    device: { name: "MacBook", icon: Laptop },
    privacyTag: "private",
    title: "Investor call — Sequoia (Mike K.)",
    body: "45-min call. Discussed Series A bridge. HR elevated during term-sheet discussion (158 peak). Action items: send updated cap table.",
    tags: ["work", "call"],
    triggeredCard: "C1 Fund SAFE Conversion …",
  },
  {
    time: "12:40 PM",
    icon: Soup,
    device: { name: "iPhone", icon: Smartphone },
    privacyTag: "private",
    title: "Lunch at Souvla with Priya",
    body: "Discussed weekend Tahoe trip. Priya mentioned her sister's wedding in June — calendar hold queued.",
    tags: ["life", "social"],
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

/* ──────────────── COMPONENT ──────────────── */

interface AmbientViewProps {
  onConnectMore?: () => void;
  autoOpenLive?: boolean;
  onAutoOpenHandled?: () => void;
  /** Parent owns the fullscreen overlay; Ambient only requests it. */
  onOpenFullscreen?: (session: LiveSession) => void;
}

export default function AmbientView({ onConnectMore, autoOpenLive, onAutoOpenHandled, onOpenFullscreen }: AmbientViewProps = {}) {
  const { settings, patch } = useUserSettings();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(() =>
    getAmbientRuntime().status(),
  );
  const [togglePending, setTogglePending] = useState(false);
  const [liveIndex, setLiveIndex] = useState(0);
  const [view, setView] = useState<"timeline" | "devices">("timeline");

  const [liveDismissed, setLiveDismissed] = useState(false);
  const [previewVisibleCount, setPreviewVisibleCount] = useState(1);
  const connectedCount = DEVICES.filter((d) => d.connected).length;

  useEffect(() => {
    const rt = getAmbientRuntime();
    return rt.subscribe(() => setRuntimeStatus(rt.status()));
  }, []);

  // Reflect server-side consent first; fall back to live runtime state
  // before settings hydrate so the hero doesn't flicker on mount.
  const consentOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : null;
  const runtimeOn = runtimeStatus.sources.some((s) => s.enabled);
  const ambientOn = consentOn ?? runtimeOn;
  const uploadsLocked = runtimeStatus.uploadsLocked;
  const firstSourceError =
    runtimeStatus.sources.find((s) => s.lastError)?.lastError ?? null;

  const handleAmbientToggle = useCallback(async () => {
    if (togglePending) return;
    const next = !ambientOn;
    setTogglePending(true);
    try {
      const consentPatch = Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: next }]),
      );
      const updated = await patch({ ambientSources: consentPatch });
      if (next) {
        const enabledSources = updated
          ? (Object.entries(updated.ambientSources ?? {})
              .filter(([, v]) => v?.enabled === true)
              .map(([k]) => k as SourceKey))
          : ALL_SOURCE_KEYS;
        startAmbientUpload({ enabledSources });
      } else {
        await stopAmbientUpload();
      }
    } finally {
      setTogglePending(false);
    }
  }, [ambientOn, patch, togglePending]);

  const handleLockToggle = useCallback(() => {
    getAmbientRuntime().setUploadsLocked(!uploadsLocked);
  }, [uploadsLocked]);

  const liveSession = ambientOn && !liveDismissed ? LIVE_SCENARIOS[liveIndex] : null;

  // Auto-open fullscreen when triggered from outside (e.g., Constellation Live row)
  useEffect(() => {
    if (autoOpenLive && liveSession) {
      onOpenFullscreen?.(liveSession);
      onAutoOpenHandled?.();
    }
  }, [autoOpenLive, liveSession, onOpenFullscreen, onAutoOpenHandled]);


  // Cycle through live scenarios every 12s for demo
  useEffect(() => {
    if (!ambientOn) return;
    const t = setInterval(() => {
      setLiveIndex((i) => (i + 1) % LIVE_SCENARIOS.length);
      setLiveDismissed(false);
    }, 12000);
    return () => clearInterval(t);
  }, [ambientOn]);

  // Reset preview stream when the active session changes
  useEffect(() => {
    setPreviewVisibleCount(1);
  }, [liveIndex, ambientOn, liveDismissed]);

  // Stream new assist messages into the preview every 2.6s
  useEffect(() => {
    if (!liveSession) return;
    if (previewVisibleCount >= liveSession.assists.length) return;
    const t = setTimeout(() => setPreviewVisibleCount((c) => c + 1), 2600);
    return () => clearTimeout(t);
  }, [previewVisibleCount, liveSession]);

  const handleConnectMore = () => {
    if (onConnectMore) onConnectMore();
    else if (typeof window !== "undefined") window.location.href = "/control";
  };

  return (
    <div
      className="h-full overflow-y-auto pb-32 px-4"
      style={{ paddingTop: "calc(3.5rem + env(safe-area-inset-top, 0px))" }}
    >
      {/* ── Header ── */}
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight leading-tight">
          Ambient
        </h1>
        <div className="mt-1 flex items-center gap-1.5 text-[13px] text-foreground/60">
          <span>{connectedCount} devices</span>
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
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                ambientOn ? "bg-foreground text-background" : "bg-foreground/10 text-foreground/40"
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
              className={`w-9 h-9 rounded-full flex items-center justify-center border transition-colors ${
                uploadsLocked
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
            className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-60 disabled:cursor-progress ${
              ambientOn ? "bg-foreground" : "bg-foreground/20"
            }`}
            aria-label="Toggle ambient"
            aria-busy={togglePending}
          >
            <motion.span
              layout
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
              className={`absolute top-0.5 w-6 h-6 rounded-full bg-background shadow-sm ${
                ambientOn ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {/* ── LIVE SESSION (only when ambient on + active) ── */}
      <AnimatePresence mode="wait">
        {liveSession && (
          <motion.div
            key={liveSession.title}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.4 }}
            className="mb-5 rounded-2xl overflow-hidden relative"
            style={{
              background:
                "linear-gradient(135deg, hsl(304 75% 63% / 0.12) 0%, hsl(304 75% 63% / 0.08) 100%)",
              border: "1px solid hsl(304 75% 63% / 0.30)",
              boxShadow: "0 8px 32px hsl(304 75% 63% / 0.15)",
            }}
          >
            {/* Live ribbon */}
            <div className="px-3.5 py-2 flex items-center justify-between border-b border-[hsl(304_75%_63%/0.18)] bg-[hsl(304_75%_63%/0.06)]">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="relative flex w-2 h-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[hsl(304_75%_63%)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[hsl(304_75%_63%)]" />
                </span>
                <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[hsl(304_75%_42%)] truncate">
                  Live · {liveSession.kind}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => onOpenFullscreen?.(liveSession)}
                  className="h-9 px-3.5 rounded-full flex items-center gap-1.5 text-[12px] font-semibold text-[hsl(304_75%_32%)] hover:text-[hsl(304_75%_22%)] bg-[hsl(304_75%_63%/0.16)] hover:bg-[hsl(304_75%_63%/0.26)] border border-[hsl(304_75%_63%/0.35)] active:scale-[0.97] transition-all shadow-sm"
                  aria-label="Open fullscreen session"
                  title="Focus mode"
                >
                  <Expand size={14} strokeWidth={2.4} />
                  <span>Focus</span>
                </button>
                <button
                  onClick={() => setLiveDismissed(true)}
                  className="w-9 h-9 rounded-full flex items-center justify-center text-foreground/70 hover:text-foreground bg-foreground/[0.05] hover:bg-foreground/[0.12] border border-foreground/[0.10] active:scale-[0.97] transition-all"
                  aria-label="End session"
                >
                  <X size={17} strokeWidth={2.2} />
                </button>
              </div>
            </div>

            {/* Compact "now playing" row — always visible */}
            <div className="px-3 pt-3 pb-2 flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] border border-foreground/[0.08] flex items-center justify-center text-foreground shrink-0">
                <liveSession.icon size={17} strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-foreground leading-snug truncate">
                  {liveSession.title}
                </p>
                <p className="text-[11px] text-foreground/55 mt-0.5 flex items-center gap-1 truncate">
                  <MapPin size={10} className="shrink-0" />
                  <span className="truncate">{liveSession.location}</span>
                  <span className="text-foreground/30">·</span>
                  <span className="truncate">{liveSession.device}</span>
                </p>
              </div>
            </div>

            {/* Fixed-height assist preview — newest 3 messages, newest slides in at top */}
            <div className="px-4 pb-3.5">
              <div className="h-[126px] overflow-hidden relative">
                <AnimatePresence initial={false} mode="popLayout">
                  {liveSession.assists
                    .slice(0, previewVisibleCount)
                    .slice(-3)
                    .reverse()
                    .map((a, idx) => {
                      const ageOpacity = idx === 0 ? 1 : idx === 1 ? 0.7 : 0.42;
                      const isNewest = idx === 0;
                      return (
                        <motion.div
                          key={a.time + a.text}
                          layout
                          initial={{ opacity: 0, y: -18, filter: "blur(6px)", scale: 0.97 }}
                          animate={{ opacity: ageOpacity, y: 0, filter: "blur(0px)", scale: 1 }}
                          exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                          transition={{
                            opacity: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
                            y: { type: "spring", stiffness: 320, damping: 30, mass: 0.7 },
                            filter: { duration: 0.4, ease: "easeOut" },
                            scale: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
                            layout: { type: "spring", stiffness: 320, damping: 32, mass: 0.7 },
                          }}
                          className="flex gap-2.5 py-1"
                        >
                          <span
                            className={`text-[9px] font-mono pt-0.5 w-10 shrink-0 tabular-nums transition-colors duration-500 ${
                              isNewest ? "text-[hsl(304_75%_45%)]" : "text-foreground/35"
                            }`}
                          >
                            {a.time}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p
                              className={`text-[12.5px] leading-snug ${
                                a.kind === "action"
                                  ? "text-foreground font-medium"
                                  : a.kind === "assist"
                                    ? "text-foreground/85"
                                    : "text-foreground/65"
                              }`}
                            >
                              {a.kind === "action" && (
                                <span className="inline-block mr-1.5 px-1.5 py-0 rounded text-[9px] font-bold uppercase tracking-wider bg-[hsl(304_75%_63%)] text-white align-middle">
                                  Action
                                </span>
                              )}
                              {a.text}
                            </p>
                          </div>
                        </motion.div>
                      );
                    })}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
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
            {DEVICES.filter((d) => d.connected).map((device) => {
              const Icon = device.icon;
              return (
                <div
                  key={device.name}
                  title={`${device.name} · ${device.detail}`}
                  className="relative w-7 h-7 rounded-full bg-background border border-foreground/10 flex items-center justify-center text-foreground/80"
                >
                  <Icon size={13} strokeWidth={1.8} />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-background ${
                      device.signal === "weak" ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                  />
                </div>
              );
            })}
            <div className="relative w-7 h-7 rounded-full bg-foreground/5 border border-dashed border-foreground/25 flex items-center justify-center text-foreground/50">
              <Plus size={12} strokeWidth={2.2} />
            </div>
          </div>

          <div className="text-right pr-1 shrink-0">
            <p className="text-[11px] font-medium text-foreground/75 leading-tight">
              {DEVICES.length - connectedCount} more available
            </p>
            <p className="text-[9px] text-foreground/45 leading-tight mt-0.5 flex items-center gap-0.5 justify-end">
              Connect in Control <ChevronRight size={9} />
            </p>
          </div>
        </div>
      </button>

      {/* ── Today's narrative summary ── */}
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
          <span className="text-[10px] text-foreground/45 font-mono">{TIMELINE.length} entries</span>
        </div>
        <p className="text-[13px] leading-relaxed text-foreground/85">{NARRATIVE_SUMMARY}</p>
      </div>

      {/* ── Timeline ── */}
      <div className="space-y-2.5">
        {TIMELINE.map((entry, idx) => (
          <motion.div
            key={entry.time + entry.title}
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
                  </div>
                  <button className="text-foreground/30 hover:text-foreground/60 shrink-0" aria-label="Dismiss">
                    <X size={13} />
                  </button>
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
                      → Triggered this card in NOW
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
                      className={`text-[11px] font-mono pt-1 w-14 shrink-0 tabular-nums transition-colors duration-500 ${
                        isNewest ? "text-[hsl(304_75%_70%)]" : "text-white/30"
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
                        className={`leading-snug transition-colors duration-500 ${
                          a.kind === "action"
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
