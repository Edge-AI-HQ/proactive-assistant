import type { TranscriptReadyEvent } from "@pin/capacitor-ambient-ai";
import {
  Coffee,
  Mic,
  Stethoscope,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface LiveAssistItem {
  time: string;
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
  text: string;
  source?: string;
}

export interface LiveSessionData {
  captureSessionId: string;
  startedAt: number;
  messages: LiveAssistMessage[];
}

const MAX_LIVE_MESSAGES = 30;
const LIVE_SESSION_TITLE_MAX = 64;

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
  const text = event.text.trim();
  const isNewSession = !prev || prev.captureSessionId !== event.captureSessionId;
  const startedAt = isNewSession ? Date.now() : prev.startedAt;
  const elapsed = Math.max(0, Date.now() - startedAt);
  const message: LiveAssistMessage = {
    id: event.burstId || `${event.captureSessionId}:${Date.now()}`,
    time: formatElapsed(elapsed),
    text,
    source: event.provider,
  };
  const messages = isNewSession
    ? [message]
    : [...prev.messages, message].slice(-MAX_LIVE_MESSAGES);
  return {
    captureSessionId: event.captureSessionId,
    startedAt,
    messages,
  };
}

export function liveSessionDataToSession(
  ambientOn: boolean,
  data: LiveSessionData | null,
): LiveSession | null {
  if (!ambientOn || !data || data.messages.length === 0) return null;
  const last = data.messages[data.messages.length - 1];
  const title = last.text.length > LIVE_SESSION_TITLE_MAX
    ? `${last.text.slice(0, LIVE_SESSION_TITLE_MAX - 1).trimEnd()}…`
    : last.text;
  const provider = last.source ?? "device";
  return {
    icon: Mic,
    kind: "Voice session",
    title: title || "Live transcript",
    location: "On device · captured locally",
    device: "Microphone",
    startedAt: formatStartTimestamp(data.startedAt),
    signals: [
      `${data.messages.length} transcript${data.messages.length === 1 ? "" : "s"}`,
      `Provider: ${provider}`,
    ],
    assists: data.messages.map((m) => ({
      time: m.time,
      kind: "context" as const,
      text: m.text,
      source: m.source,
    })),
  };
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
