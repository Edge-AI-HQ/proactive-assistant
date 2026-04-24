import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRightCircle,
  Briefcase,
  Check,
  ChevronDown,
  Heart,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  Sprout,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import {
  fetchRawDeviceApps,
  fetchRawDeviceContacts,
  fetchRawGcal,
  fetchRawGmail,
  fetchMemories,
  fetchProfileSnapshot,
  fetchSignals,
  type DeviceAppRaw,
  type DeviceContactRaw,
  type GcalEvent,
  type GmailMessage,
  type Goal,
  type Memory,
  type PersonalSignal,
  type ProfileSnapshot,
} from "@/lib/api";
import { basketMeta } from "@/lib/basket-meta";
import type { ComposioState } from "@/hooks/useComposio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VisualStatus = "Normal" | "Alert" | "Watch";
type ProfileGroupKey = "facts" | "preferences" | "constraints" | "metadata";
type DataPanel = "mirror" | "memory" | "signals" | "raw";
type RawPanel = "gmail" | "gcal" | "apps" | "contacts";
type SectionId = DataPanel | "goals";
type RawSourceKind = "connector" | "device";

interface GoalVisualMeta {
  image: string;
  pct: number;
  weeklyActions: string[];
  monitoring: string[];
  aiQuestions: string[];
}

// ---------------------------------------------------------------------------
// Constants — gateway visual grid
// ---------------------------------------------------------------------------

const BASE = import.meta.env.BASE_URL;

const GOAL_VISUAL_META: Record<string, GoalVisualMeta> = {
  "career-growth": {
    image: `${BASE}goal-work.png`,
    pct: 62,
    weeklyActions: [
      "Review project milestones for this sprint",
      "Follow up on pending decisions",
      "Check team blockers and unblock",
    ],
    monitoring: ["Career development trajectory", "Skill gap analysis", "Industry trends"],
    aiQuestions: ["What skill are you focusing on developing?", "Any career goals shifting this quarter?"],
  },
  work: {
    image: `${BASE}goal-work.png`,
    pct: 62,
    weeklyActions: [
      "Review project milestones for this sprint",
      "Follow up on pending decisions",
      "Check team blockers and unblock",
    ],
    monitoring: ["Career development trajectory", "Skill gap analysis", "Industry trends"],
    aiQuestions: ["What skill are you focusing on developing?", "Any career goals shifting this quarter?"],
  },
  "stay-healthy": {
    image: `${BASE}goal-health.png`,
    pct: 35,
    weeklyActions: ["No new health signals this cycle"],
    monitoring: ["Exercise consistency", "Sleep quality trends", "Annual checkup schedule"],
    aiQuestions: ["What health tracking are you currently doing?", "Any specific health topics you're watching?"],
  },
  health: {
    image: `${BASE}goal-health.png`,
    pct: 35,
    weeklyActions: ["No new health signals this cycle"],
    monitoring: ["Exercise consistency", "Sleep quality trends", "Annual checkup schedule"],
    aiQuestions: ["What health tracking are you currently doing?", "Any specific health topics you're watching?"],
  },
  "financial-plan": {
    image: `${BASE}goal-finance.png`,
    pct: 52,
    weeklyActions: ["Review monthly spending summary", "Check upcoming bills and subscriptions"],
    monitoring: ["Budget vs. actual spending", "Savings rate", "Investment performance"],
    aiQuestions: ["Any budget concerns for this quarter?", "Should I prepare a savings analysis?"],
  },
  finance: {
    image: `${BASE}goal-finance.png`,
    pct: 52,
    weeklyActions: ["Review monthly spending summary", "Check upcoming bills and subscriptions"],
    monitoring: ["Budget vs. actual spending", "Savings rate", "Investment performance"],
    aiQuestions: ["Any budget concerns for this quarter?", "Should I prepare a savings analysis?"],
  },
  wealth: {
    image: `${BASE}goal-finance.png`,
    pct: 52,
    weeklyActions: ["Review monthly spending summary", "Check upcoming bills and subscriptions"],
    monitoring: ["Budget vs. actual spending", "Savings rate", "Investment performance"],
    aiQuestions: ["Any budget concerns for this quarter?", "Should I prepare a savings analysis?"],
  },
  "learn-and-grow": {
    image: `${BASE}goal-growth.png`,
    pct: 72,
    weeklyActions: ["Continue current learning path", "Review bookmarked articles"],
    monitoring: ["Learning time allocation", "New topics of interest", "Skill acquisition progress"],
    aiQuestions: ["What topic are you most curious about right now?", "Should I find new learning resources?"],
  },
  growth: {
    image: `${BASE}goal-growth.png`,
    pct: 72,
    weeklyActions: ["Continue current learning path", "Review bookmarked articles"],
    monitoring: ["Learning time allocation", "New topics of interest", "Skill acquisition progress"],
    aiQuestions: ["What topic are you most curious about right now?", "Should I find new learning resources?"],
  },
  relationships: {
    image: `${BASE}goal-family.png`,
    pct: 50,
    weeklyActions: ["Plan weekend family activity", "Check in with close friends"],
    monitoring: ["Family event calendar", "Relationship check-in frequency"],
    aiQuestions: ["Any family events coming up?", "How's the work-life balance feeling?"],
  },
  family: {
    image: `${BASE}goal-family.png`,
    pct: 50,
    weeklyActions: ["Plan weekend family activity", "Check in with close friends"],
    monitoring: ["Family event calendar", "Relationship check-in frequency"],
    aiQuestions: ["Any family events coming up?", "How's the work-life balance feeling?"],
  },
  "life-balance": {
    image: `${BASE}goal-life.png`,
    pct: 40,
    weeklyActions: ["Block personal time on calendar", "Review stress levels"],
    monitoring: ["Personal time allocation", "Burnout risk indicators", "Hobby engagement"],
    aiQuestions: ["Any personal projects you want to prioritize?", "What recharges you most right now?"],
  },
  life: {
    image: `${BASE}goal-life.png`,
    pct: 40,
    weeklyActions: ["Block personal time on calendar", "Review stress levels"],
    monitoring: ["Personal time allocation", "Burnout risk indicators", "Hobby engagement"],
    aiQuestions: ["Any personal projects you want to prioritize?", "What recharges you most right now?"],
  },
};

const FALLBACK_VISUAL: GoalVisualMeta = {
  image: `${BASE}goal-life.png`,
  pct: 50,
  weeklyActions: [],
  monitoring: [],
  aiQuestions: [],
};

function getVisualMeta(key: string): GoalVisualMeta {
  return GOAL_VISUAL_META[key] ?? GOAL_VISUAL_META[key.split("-")[0]] ?? FALLBACK_VISUAL;
}

function priorityToStatus(priority: string): VisualStatus {
  if (priority === "high") return "Alert";
  if (priority === "low") return "Watch";
  return "Normal";
}

const statusColor: Record<VisualStatus, string> = {
  Normal: "bg-emerald-400/30",
  Alert: "bg-rose-400/30",
  Watch: "bg-amber-400/30",
};

const statusBarColor: Record<VisualStatus, string> = {
  Normal: "bg-emerald-400/50",
  Alert: "bg-rose-400/50",
  Watch: "bg-amber-400/50",
};

// ---------------------------------------------------------------------------
// Constants — upstream profile sections
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: ProfileSnapshot = {
  profile: null,
  goals: [],
  memories: [],
  signals: [],
  interests: [],
};

const LIST_PAGE_SIZE = 12;
const TOPIC_MEMORY_PREVIEW_LIMIT = 8;
const RAW_PREVIEW_LIMIT = 12;

interface RawPreview {
  gmail: GmailMessage[];
  gcal: GcalEvent[];
  apps: DeviceAppRaw[];
  contacts: DeviceContactRaw[];
  gmailTotal: number;
  gcalTotal: number;
  appsTotal: number;
  contactsTotal: number;
}

interface RawSourceOption {
  id: RawPanel;
  label: string;
  kind: RawSourceKind;
  count: number;
  connected: boolean;
}

const EMPTY_RAW_PREVIEW: RawPreview = {
  gmail: [],
  gcal: [],
  apps: [],
  contacts: [],
  gmailTotal: 0,
  gcalTotal: 0,
  appsTotal: 0,
  contactsTotal: 0,
};

const RAW_SOURCE_CONFIG: Array<{
  id: RawPanel;
  label: string;
  kind: RawSourceKind;
  connectorToolkits?: string[];
}> = [
  { id: "gmail", label: "Gmail", kind: "connector", connectorToolkits: ["gmail"] },
  { id: "gcal", label: "Calendar", kind: "connector", connectorToolkits: ["googlecalendar"] },
  { id: "apps", label: "Device Apps", kind: "device" },
  { id: "contacts", label: "Contacts", kind: "device" },
];

const GOAL_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  "career-growth": { icon: Briefcase, label: "Career" },
  "stay-healthy": { icon: Heart, label: "Health" },
  "financial-plan": { icon: TrendingUp, label: "Finance" },
  "learn-and-grow": { icon: Sprout, label: "Growth" },
  relationships: { icon: Users, label: "Relationships" },
  "life-balance": { icon: Sparkles, label: "Life Balance" },
  work: { icon: Briefcase, label: "Work" },
  health: { icon: Heart, label: "Health" },
  finance: { icon: TrendingUp, label: "Finance" },
  growth: { icon: Sprout, label: "Growth" },
  family: { icon: Users, label: "Family" },
  life: { icon: Sparkles, label: "Life" },
};

const FALLBACK_ICON = { icon: Sparkles, label: "Goal" };

const PROFILE_GROUP_META: Array<{
  key: ProfileGroupKey;
  title: string;
  description: string;
}> = [
  { key: "facts", title: "Facts", description: "Stable details the assistant knows about you." },
  { key: "preferences", title: "Preferences", description: "How you prefer the assistant to behave." },
  { key: "constraints", title: "Constraints", description: "Rules and boundaries the assistant should honor." },
  { key: "metadata", title: "Metadata", description: "System-managed fields attached to your profile." },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatMetric(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return value.toFixed(digits);
}

function mergeUniqueById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function hasObjectKeys(value: Record<string, unknown> | null | undefined): boolean {
  return !!value && Object.keys(value).length > 0;
}

function rawCount(raw: RawPreview, panel: RawPanel): number {
  if (panel === "gmail") return raw.gmailTotal;
  if (panel === "gcal") return raw.gcalTotal;
  if (panel === "apps") return raw.appsTotal;
  return raw.contactsTotal;
}

function normalizeToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase().replace(/[-_\s]/g, "");
}

function buildRawSourceOptions(
  raw: RawPreview,
  connections: ComposioState["connections"],
): RawSourceOption[] {
  const connectedToolkits = new Set(
    connections
      .filter((conn) => conn.status === "ACTIVE")
      .map((conn) => normalizeToolkit(conn.toolkit)),
  );

  return RAW_SOURCE_CONFIG
    .map((source) => {
      const count = rawCount(raw, source.id);
      const connected =
        source.kind === "device"
          ? count > 0
          : (source.connectorToolkits ?? []).some((toolkit) => connectedToolkits.has(normalizeToolkit(toolkit)));

      return {
        id: source.id,
        label: source.label,
        kind: source.kind,
        count,
        connected,
      };
    })
    .filter((source) => source.connected || source.count > 0);
}

type PillTone = "neutral" | "source" | "subject" | "quality" | "confidence" | "status" | "device";

const PILL_TONE_CLASS: Record<PillTone, string> = {
  neutral: "bg-slate-500/[0.08] text-slate-700 ring-slate-500/[0.12]",
  source: "bg-amber-500/[0.12] text-amber-700 ring-amber-500/[0.18]",
  subject: "bg-sky-500/[0.12] text-sky-700 ring-sky-500/[0.18]",
  quality: "bg-emerald-500/[0.12] text-emerald-700 ring-emerald-500/[0.18]",
  confidence: "bg-violet-500/[0.12] text-violet-700 ring-violet-500/[0.18]",
  status: "bg-teal-500/[0.12] text-teal-700 ring-teal-500/[0.18]",
  device: "bg-rose-500/[0.10] text-rose-700 ring-rose-500/[0.16]",
};

function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span className={`rounded-full px-2 py-1 text-[10px] font-medium ring-1 ${PILL_TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

async function fetchRawPreview(signal?: AbortSignal): Promise<RawPreview> {
  const [gmail, gcal, apps, contacts] = await Promise.allSettled([
    fetchRawGmail({ limit: RAW_PREVIEW_LIMIT }, signal),
    fetchRawGcal({ limit: RAW_PREVIEW_LIMIT }, signal),
    fetchRawDeviceApps({ latestSnapshotOnly: true, limit: RAW_PREVIEW_LIMIT }, signal),
    fetchRawDeviceContacts({ latestSnapshotOnly: true, limit: RAW_PREVIEW_LIMIT }, signal),
  ]);
  return {
    gmail: gmail.status === "fulfilled" ? gmail.value.messages : [],
    gcal: gcal.status === "fulfilled" ? gcal.value.events : [],
    apps: apps.status === "fulfilled" ? apps.value.apps : [],
    contacts: contacts.status === "fulfilled" ? contacts.value.contacts : [],
    gmailTotal: gmail.status === "fulfilled" ? (gmail.value.total ?? gmail.value.messages.length) : 0,
    gcalTotal: gcal.status === "fulfilled" ? (gcal.value.total ?? gcal.value.events.length) : 0,
    appsTotal: apps.status === "fulfilled" ? (apps.value.total ?? apps.value.apps.length) : 0,
    contactsTotal: contacts.status === "fulfilled" ? (contacts.value.total ?? contacts.value.contacts.length) : 0,
  };
}

// ---------------------------------------------------------------------------
// Sub-components (upstream profile sections)
// ---------------------------------------------------------------------------

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.03] px-4 py-5 text-center">
      <p className="text-sm font-medium text-foreground/70">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground/45">{description}</p>
    </div>
  );
}

function countProfileFields(profile: ProfileSnapshot["profile"]): number {
  if (!profile) return 0;
  return PROFILE_GROUP_META.reduce((sum, group) => sum + Object.keys(profile[group.key] ?? {}).length, 0);
}

function MetricCard({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-20 rounded-2xl bg-white/45 px-3 py-3 text-left ring-1 ring-white/55 transition-colors hover:bg-white/75"
    >
      <div className="text-[10px] uppercase tracking-[0.16em] text-foreground/35">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-xl font-semibold text-foreground">{value}</span>
        <span className="text-[11px] font-medium text-foreground/42">{detail}</span>
      </div>
    </button>
  );
}

function LoadMoreButton({
  hasMore,
  loading,
  label,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  label: string;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-white/55 px-4 py-3 text-sm font-medium text-foreground/62 ring-1 ring-white/60 transition-colors hover:bg-white/80 disabled:cursor-wait disabled:opacity-60"
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {label}
    </button>
  );
}

function WorkbenchTabButton({
  active,
  label,
  value,
  onClick,
}: {
  active: boolean;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-16 rounded-2xl px-3 py-3 text-left ring-1 transition-colors ${
        active
          ? "bg-foreground text-background ring-foreground"
          : "bg-white/50 text-foreground ring-white/60 hover:bg-white/80"
      }`}
    >
      <div className={`text-[10px] uppercase tracking-[0.16em] ${active ? "text-background/60" : "text-foreground/35"}`}>
        {label}
      </div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </button>
  );
}

function ProfileGroupCard({
  title,
  description,
  values,
  expanded,
  onToggle,
}: {
  title: string;
  description: string;
  values: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const entries = Object.entries(values);

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium text-foreground/45">
              {entries.length}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/42">{description}</p>
        </div>
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={`shrink-0 text-foreground/25 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-foreground/8 px-4 py-3">
              {entries.length === 0 ? (
                <EmptyState
                  title={`No ${title.toLowerCase()} yet`}
                  description="This group is empty right now."
                />
              ) : (
                <div className="space-y-3">
                  {entries.map(([key, value]) => (
                    <div key={key} className="rounded-2xl bg-foreground/[0.03] px-3 py-3">
                      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-foreground/38">
                        {key}
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/72">
                        {formatValue(value)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MemoryItem({ memory }: { memory: Memory }) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <Pill tone="source">{memory.source}</Pill>
        <span className="text-[11px] text-foreground/35">
          {formatDateTime(memory.occurred_at ?? memory.created_at)}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-foreground/78">{memory.text}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {memory.subject && <Pill tone="subject">{memory.subject}</Pill>}
        <Pill tone="quality">quality {formatMetric(memory.quality)}</Pill>
        <Pill tone="confidence">confidence {formatMetric(memory.confidence)}</Pill>
      </div>
      {memory.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {memory.tags.map((tag) => (
            <Pill key={`${memory.id}-${tag}`} tone="neutral">#{tag}</Pill>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalItem({ signal }: { signal: PersonalSignal }) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{signal.title}</div>
          <div className="mt-1 text-xs text-foreground/45">
            {signal.kind}
            {signal.source ? ` · ${signal.source}` : ""}
            {signal.device_id ? ` · ${signal.device_id}` : ""}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-foreground/35">{formatDateTime(signal.occurred_at)}</span>
      </div>
      {signal.summary && (
        <p className="mt-2 text-sm leading-6 text-foreground/70">{signal.summary}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill tone="status">{signal.status}</Pill>
        <Pill tone="quality">salience {formatMetric(signal.salience)}</Pill>
        <Pill tone="confidence">confidence {formatMetric(signal.confidence)}</Pill>
        {signal.subject && <Pill tone="subject">{signal.subject}</Pill>}
      </div>
      {hasObjectKeys(signal.payload) && (
        <details className="mt-3 rounded-2xl bg-white/55 px-3 py-2 text-[11px] leading-5 text-foreground/62 ring-1 ring-white/60">
          <summary className="cursor-pointer text-foreground/45">Payload</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">{formatValue(signal.payload)}</pre>
        </details>
      )}
    </div>
  );
}

function RawRecordItem({
  source,
  title,
  subtitle,
  time,
  payload,
}: {
  source: string;
  title: string;
  subtitle?: string | null;
  time?: string | null;
  payload?: Record<string, unknown>;
}) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/38">{source}</div>
          <div className="mt-1 truncate text-sm font-semibold text-foreground">{title}</div>
          {subtitle && <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground/52">{subtitle}</p>}
        </div>
        <span className="shrink-0 text-[11px] text-foreground/35">{formatDateTime(time)}</span>
      </div>
      {payload && hasObjectKeys(payload) && (
        <details className="mt-3 rounded-2xl bg-white/55 px-3 py-2 text-[11px] leading-5 text-foreground/62 ring-1 ring-white/60">
          <summary className="cursor-pointer text-foreground/45">Raw fields</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">{formatValue(payload)}</pre>
        </details>
      )}
    </div>
  );
}

function MirrorPanel({
  profile,
  topicMemories,
  openGroups,
  onToggleGroup,
}: {
  profile: ProfileSnapshot["profile"];
  topicMemories: Memory[];
  openGroups: Record<ProfileGroupKey, boolean>;
  onToggleGroup: (group: ProfileGroupKey) => void;
}) {
  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">Mirror</h2>
        <p className="mt-1 max-w-2xl text-[11px] leading-5 text-foreground/42">
          Profile facts, preferences, constraints, and topic memory in one derived view.
        </p>
      </div>

      <div className="max-h-[58vh] min-h-[360px] space-y-4 overflow-y-auto pr-1">
        <div className="space-y-3">
          {PROFILE_GROUP_META.map((group) => (
            <ProfileGroupCard
              key={group.key}
              title={group.title}
              description={group.description}
              values={profile?.[group.key] ?? {}}
              expanded={openGroups[group.key]}
              onToggle={() => onToggleGroup(group.key)}
            />
          ))}
        </div>

        <div className="rounded-2xl bg-foreground/[0.03] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">Topic Memory</h3>
            <span className="text-xs text-foreground/38">{topicMemories.length}</span>
          </div>
          <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {topicMemories.length === 0 ? (
              <EmptyState
                title="No topic memory"
                description="Interest-like data now appears as memory rows, usually under topic subjects."
              />
            ) : (
              topicMemories.map((memory) => <MemoryItem key={memory.id} memory={memory} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MemoryPanel({
  memories,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  memories: Memory[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Memory</h2>
          <p className="mt-1 text-[11px] leading-5 text-foreground/42">
            Long-term things the assistant remembers about you. This panel pages without stretching the whole page.
          </p>
        </div>
        <div className="shrink-0 rounded-2xl bg-foreground/5 px-3 py-2 text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-foreground/35">Total</div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">{total}</div>
        </div>
      </div>
      <div className="max-h-[58vh] min-h-[360px] space-y-3 overflow-y-auto pr-1">
        {memories.length === 0 ? (
          <EmptyState title="No memories yet" description="Nothing has been saved as long-term memory yet." />
        ) : (
          memories.map((memory) => <MemoryItem key={memory.id} memory={memory} />)
        )}
        <LoadMoreButton
          hasMore={hasMore}
          loading={loadingMore}
          label="Load more memories"
          onClick={onLoadMore}
        />
      </div>
    </div>
  );
}

function SignalsPanel({
  signals,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  signals: PersonalSignal[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Signals</h2>
          <p className="mt-1 text-[11px] leading-5 text-foreground/42">
            Recent observations that may become memory after the assistant sees enough context.
          </p>
        </div>
        <div className="shrink-0 rounded-2xl bg-foreground/5 px-3 py-2 text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-foreground/35">Total</div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">{total}</div>
        </div>
      </div>
      <div className="max-h-[58vh] min-h-[360px] space-y-3 overflow-y-auto pr-1">
        {signals.length === 0 ? (
          <EmptyState title="No signals yet" description="Recent observations will appear here after connected sources provide data." />
        ) : (
          signals.map((signal) => <SignalItem key={signal.id} signal={signal} />)
        )}
        <LoadMoreButton
          hasMore={hasMore}
          loading={loadingMore}
          label="Load more signals"
          onClick={onLoadMore}
        />
      </div>
    </div>
  );
}

function RawPanelContent({
  raw,
  sources,
  activeRawPanel,
  onChangeRawPanel,
}: {
  raw: RawPreview;
  sources: RawSourceOption[];
  activeRawPanel: RawPanel;
  onChangeRawPanel: (panel: RawPanel) => void;
}) {
  const activeSource = sources.find((source) => source.id === activeRawPanel) ?? sources[0];

  return (
    <div>
      <div className="mb-3 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Raw</h2>
          <p className="mt-1 text-[11px] leading-5 text-foreground/42">
            Source data from connected apps and devices before it becomes memories or profile details.
          </p>
        </div>
        <div className="rounded-2xl bg-foreground/5 p-2">
          <label className="mb-1.5 block text-[10px] uppercase tracking-[0.16em] text-foreground/35">
            Data source
          </label>
          <div className="relative">
            <select
              value={activeSource?.id ?? ""}
              disabled={sources.length === 0}
              onChange={(event) => onChangeRawPanel(event.target.value as RawPanel)}
              className="h-11 w-full appearance-none rounded-xl bg-white/65 px-3 pr-10 text-sm font-medium text-foreground ring-1 ring-white/70 outline-none transition-colors hover:bg-white/85 disabled:text-foreground/35"
            >
              {sources.length === 0 ? (
                <option value="">No connected data source</option>
              ) : (
                sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label} ({source.count})
                  </option>
                ))
              )}
            </select>
            <ChevronDown
              size={15}
              strokeWidth={1.6}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-foreground/35"
            />
          </div>
          {activeSource && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Pill tone={activeSource.kind === "device" ? "device" : "source"}>
                {activeSource.kind === "device" ? "Device" : "Connector"}
              </Pill>
              <Pill tone="quality">{activeSource.count} rows</Pill>
            </div>
          )}
        </div>
      </div>

      <div className="max-h-[58vh] min-h-[360px] space-y-3 overflow-y-auto pr-1">
        {!activeSource && (
          <EmptyState
            title="No connected data source"
            description="Connect an app or sync a device to show source data here."
          />
        )}
        {activeSource?.id === "gmail" && (
          raw.gmail.length === 0 ? (
            <EmptyState title="No Gmail data" description="No Gmail messages are available right now." />
          ) : (
            raw.gmail.map((message) => (
              <RawRecordItem
                key={message.id}
                source="Gmail"
                title={message.subject || message.message_id}
                subtitle={message.snippet || message.from_addr}
                time={message.occurred_at}
                payload={{
                  from_addr: message.from_addr,
                  to_addrs: message.to_addrs,
                  labels: message.label_ids,
                  reference_count: message.reference_count,
                }}
              />
            ))
          )
        )}
        {activeSource?.id === "gcal" && (
          raw.gcal.length === 0 ? (
            <EmptyState title="No Calendar data" description="No calendar events are available right now." />
          ) : (
            raw.gcal.map((event) => (
              <RawRecordItem
                key={event.id}
                source="Calendar"
                title={event.title || event.event_id}
                subtitle={event.location || event.status}
                time={event.start_at ?? event.occurred_at}
                payload={{
                  calendar_id: event.calendar_id,
                  attendees: event.attendees,
                  end_at: event.end_at,
                  reference_count: event.reference_count,
                }}
              />
            ))
          )
        )}
        {activeSource?.id === "apps" && (
          raw.apps.length === 0 ? (
            <EmptyState title="No device app data" description="No app list from your device is available right now." />
          ) : (
            raw.apps.map((app) => (
              <RawRecordItem
                key={app.id}
                source="Device Apps"
                title={app.app_name}
                subtitle={app.bundle_id}
                time={app.last_used_at ?? app.occurred_at}
                payload={{
                  device_id: app.device_id,
                  snapshot_id: app.snapshot_id,
                  version: app.version,
                  reference_count: app.reference_count,
                }}
              />
            ))
          )
        )}
        {activeSource?.id === "contacts" && (
          raw.contacts.length === 0 ? (
            <EmptyState title="No contact data" description="No contacts from your device are available right now." />
          ) : (
            raw.contacts.map((contact) => (
              <RawRecordItem
                key={contact.id}
                source="Contacts"
                title={contact.display_name || contact.id}
                subtitle={[...contact.emails, ...contact.phones].slice(0, 3).join(" · ")}
                time={contact.last_modified ?? contact.occurred_at}
                payload={{
                  device_id: contact.device_id,
                  snapshot_id: contact.snapshot_id,
                  emails: contact.emails,
                  phones: contact.phones,
                  reference_count: contact.reference_count,
                }}
              />
            ))
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface GoalsViewProps {
  composio: ComposioState;
}

export default function GoalsView({ composio }: GoalsViewProps) {
  const [snapshot, setSnapshot] = useState<ProfileSnapshot>(EMPTY_SNAPSHOT);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [memoryHasMore, setMemoryHasMore] = useState(false);
  const [memoryLoadingMore, setMemoryLoadingMore] = useState(false);
  const [signals, setSignals] = useState<PersonalSignal[]>([]);
  const [signalTotal, setSignalTotal] = useState(0);
  const [signalHasMore, setSignalHasMore] = useState(false);
  const [signalLoadingMore, setSignalLoadingMore] = useState(false);
  const [topicMemories, setTopicMemories] = useState<Memory[]>([]);
  const [rawPreview, setRawPreview] = useState<RawPreview>(EMPTY_RAW_PREVIEW);
  const [activePanel, setActivePanel] = useState<DataPanel>("memory");
  const [activeRawPanel, setActiveRawPanel] = useState<RawPanel>("apps");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Gateway grid drawer state
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  // Upstream profile section state
  const [openGroups, setOpenGroups] = useState<Record<ProfileGroupKey, boolean>>({
    facts: false,
    preferences: false,
    constraints: false,
    metadata: false,
  });

  const controllerRef = useRef<AbortController | null>(null);

  // ── Data fetching ──

  const loadSnapshot = useCallback(async (options?: { silent?: boolean }) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    if (!options?.silent) setLoading(true);
    setError(null);

    try {
      const [data, memoryData, signalData, topicData, rawData] = await Promise.all([
        fetchProfileSnapshot(controller.signal),
        fetchMemories({
          status: "active",
          limit: LIST_PAGE_SIZE,
          orderBy: "created_at",
          orderDirection: "desc",
        }, controller.signal),
        fetchSignals({
          status: "open",
          limit: LIST_PAGE_SIZE,
          pruneExpired: true,
        }, controller.signal),
        fetchMemories({
          status: "active",
          subjectPrefix: "topic:",
          limit: TOPIC_MEMORY_PREVIEW_LIMIT,
          orderBy: "quality",
          orderDirection: "desc",
        }, controller.signal),
        fetchRawPreview(controller.signal).catch((err) => {
          console.warn("[GoalsView] fetchRawPreview failed:", err);
          return EMPTY_RAW_PREVIEW;
        }),
      ]);
      if (!controller.signal.aborted) {
        setSnapshot(data);
        setMemories(memoryData.memories);
        setMemoryTotal(memoryData.total ?? memoryData.memories.length);
        setMemoryHasMore(memoryData.memories.length < (memoryData.total ?? memoryData.memories.length));
        setSignals(signalData.signals);
        setSignalTotal(signalData.total ?? signalData.signals.length);
        setSignalHasMore(signalData.signals.length < (signalData.total ?? signalData.signals.length));
        setTopicMemories(topicData.memories);
        setRawPreview(rawData);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : "Failed to load profile";
        console.warn("[GoalsView] loadSnapshot failed:", err);
        setError(message);
      }
    } finally {
      if (!controller.signal.aborted && !options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
    return () => controllerRef.current?.abort();
  }, [loadSnapshot]);

  // ── Derived data ──

  const profile = snapshot.profile;
  const activeGoals = useMemo(
    () => snapshot.goals.filter((goal) => goal.status !== "closed"),
    [snapshot.goals],
  );
  const rawSources = useMemo(
    () => buildRawSourceOptions(rawPreview, composio.connections),
    [rawPreview, composio.connections],
  );

  useEffect(() => {
    if (rawSources.some((source) => source.id === activeRawPanel)) return;
    const nextPanel = rawSources[0]?.id;
    if (nextPanel && nextPanel !== activeRawPanel) {
      setActiveRawPanel(nextPanel);
    }
  }, [activeRawPanel, rawSources]);
  const scrollToSection = useCallback((sectionId: SectionId) => {
    if (sectionId !== "goals") {
      setActivePanel(sectionId);
    }
    const element = document.getElementById(sectionId === "goals" ? "profile-section-goals" : "profile-section-workbench");
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const loadMoreMemories = useCallback(async () => {
    if (memoryLoadingMore || !memoryHasMore) return;

    setMemoryLoadingMore(true);
    setError(null);
    try {
      const data = await fetchMemories({
        status: "active",
        limit: LIST_PAGE_SIZE,
        offset: memories.length,
        orderBy: "created_at",
        orderDirection: "desc",
      });
      const merged = mergeUniqueById(memories, data.memories);
      setMemories(merged);
      setMemoryHasMore(data.memories.length > 0 && merged.length < memoryTotal);
    } catch (err) {
      console.warn("[GoalsView] loadMoreMemories failed:", err);
      setError(err instanceof Error ? err.message : "Failed to load more memories");
    } finally {
      setMemoryLoadingMore(false);
    }
  }, [memories, memoryHasMore, memoryLoadingMore, memoryTotal]);

  const loadMoreSignals = useCallback(async () => {
    if (signalLoadingMore || !signalHasMore) return;

    setSignalLoadingMore(true);
    setError(null);
    try {
      const data = await fetchSignals({
        status: "open",
        limit: LIST_PAGE_SIZE,
        offset: signals.length,
        pruneExpired: true,
      });
      const merged = mergeUniqueById(signals, data.signals);
      setSignals(merged);
      setSignalHasMore(data.signals.length > 0 && merged.length < signalTotal);
    } catch (err) {
      console.warn("[GoalsView] loadMoreSignals failed:", err);
      setError(err instanceof Error ? err.message : "Failed to load more signals");
    } finally {
      setSignalLoadingMore(false);
    }
  }, [signals, signalHasMore, signalLoadingMore, signalTotal]);

  const toggleGroup = (group: ProfileGroupKey) => {
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  // ── Drawer selection for gateway grid ──

  const selectedApiGoal = expandedGoal ? activeGoals.find((g) => g.key === expandedGoal) : null;
  const selectedVisual = selectedApiGoal ? getVisualMeta(selectedApiGoal.key) : null;
  const selectedBasket = selectedApiGoal ? basketMeta(selectedApiGoal.key) : null;
  const selectedStatus = selectedApiGoal ? priorityToStatus(selectedApiGoal.priority) : "Normal";
  const rawTotal =
    rawPreview.gmailTotal +
    rawPreview.gcalTotal +
    rawPreview.appsTotal +
    rawPreview.contactsTotal;
  const profileFieldCount = countProfileFields(profile);

  const sectionMotion = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.24 },
  };

  // ── Render ──

  return (
    <div className="flex flex-col h-full px-4 pt-3 pb-2 overflow-y-auto relative">
      {/* Page header */}
      <div className="mb-6 pr-20">
        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
          Memory Profile
        </div>
        <h1 className="text-display mt-1 text-2xl text-foreground">Profile</h1>
        <p className="mt-1 truncate text-sm leading-6 text-muted-foreground">
          What your assistant knows and can use.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-14">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">Loading profile snapshot...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <motion.section {...sectionMotion} className="glass-card-strong p-4">
              <p className="text-sm font-medium text-rose-500">Could not refresh profile snapshot.</p>
              <p className="mt-1 text-xs leading-5 text-foreground/55">{error}</p>
            </motion.section>
          )}

          <motion.section {...sectionMotion} className="glass-card-strong p-5">
            <div className="space-y-4">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.18em] text-foreground/35">
                  Current Profile Data
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="text-display text-xl text-foreground">
                    {profile?.display_name?.trim() || "Unnamed user"}
                  </h2>
                  <span className="rounded-full bg-foreground/5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/42">
                    {profile?.locale ?? "n/a"}
                  </span>
                  <span className="rounded-full bg-foreground/5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/42">
                    {profile?.timezone ?? "n/a"}
                  </span>
                </div>
                <p className="mt-3 max-w-[68ch] text-sm leading-6 text-foreground/65 line-clamp-5">
                  {profile?.summary?.trim() || "No summary stored yet. The assistant will still use memories, signals, and goals below."}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <MetricCard
                label="Profile"
                value={String(profileFieldCount)}
                detail="fields"
                onClick={() => scrollToSection("mirror")}
              />
              <MetricCard
                label="Memory"
                value={String(memoryTotal)}
                detail="rows"
                onClick={() => scrollToSection("memory")}
              />
              <MetricCard
                label="Signals"
                value={String(signalTotal)}
                detail="open"
                onClick={() => scrollToSection("signals")}
              />
              <MetricCard
                label="Raw"
                value={String(rawTotal)}
                detail="rows"
                onClick={() => scrollToSection("raw")}
              />
            </div>
          </motion.section>

          <motion.section id="profile-section-goals" {...sectionMotion} className="glass-card-strong p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground">Goals</h2>
              <span className="text-xs text-foreground/38">{activeGoals.length} active</span>
            </div>
            {activeGoals.length === 0 ? (
              <EmptyState title="No active goals" description="Goals stay as a first-class collection in the mirror layer." />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {activeGoals.map((goal) => {
                  const visual = getVisualMeta(goal.key);
                  const basket = basketMeta(goal.key);
                  const status = priorityToStatus(goal.priority);
                  const Icon = basket.icon;

                  return (
                    <button
                      key={goal.key}
                      type="button"
                      className="glass-card cursor-pointer overflow-hidden text-left transition-transform active:scale-[0.98]"
                      onClick={() => setExpandedGoal(goal.key)}
                    >
                      <div className="flex h-20 items-center justify-center bg-foreground/[0.03]">
                        <img
                          src={visual.image}
                          alt={basket.label}
                          className={`w-auto object-contain ${basket.label === "Growth" ? "h-[62%]" : "h-full"}`}
                        />
                      </div>
                      <div className="p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <Icon size={18} className="text-foreground" />
                          <span className="text-display text-sm text-foreground">{basket.label}</span>
                        </div>
                        <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                          <div className={`h-full rounded-full ${statusColor[status]}`} style={{ width: `${visual.pct}%` }} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-display text-base text-foreground">{visual.pct}%</span>
                          <span className="truncate text-[11px] text-foreground/45">{goal.summary || goal.title}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.section>

          <motion.section id="profile-section-workbench" {...sectionMotion} className="glass-card-strong overflow-hidden p-0">
            <div className="border-b border-foreground/8 p-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <WorkbenchTabButton
                  active={activePanel === "mirror"}
                  label="Mirror"
                  value={profile ? "Profile" : "Empty"}
                  onClick={() => setActivePanel("mirror")}
                />
                <WorkbenchTabButton
                  active={activePanel === "memory"}
                  label="Memory"
                  value={String(memoryTotal)}
                  onClick={() => setActivePanel("memory")}
                />
                <WorkbenchTabButton
                  active={activePanel === "signals"}
                  label="Signals"
                  value={String(signalTotal)}
                  onClick={() => setActivePanel("signals")}
                />
                <WorkbenchTabButton
                  active={activePanel === "raw"}
                  label="Raw"
                  value={String(rawTotal)}
                  onClick={() => setActivePanel("raw")}
                />
              </div>
            </div>
            <div className="p-4">
              {activePanel === "mirror" && (
                <MirrorPanel
                  profile={profile}
                  topicMemories={topicMemories}
                  openGroups={openGroups}
                  onToggleGroup={toggleGroup}
                />
              )}
              {activePanel === "memory" && (
                <MemoryPanel
                  memories={memories}
                  total={memoryTotal}
                  hasMore={memoryHasMore}
                  loadingMore={memoryLoadingMore}
                  onLoadMore={loadMoreMemories}
                />
              )}
              {activePanel === "signals" && (
                <SignalsPanel
                  signals={signals}
                  total={signalTotal}
                  hasMore={signalHasMore}
                  loadingMore={signalLoadingMore}
                  onLoadMore={loadMoreSignals}
                />
              )}
              {activePanel === "raw" && (
                <RawPanelContent
                  raw={rawPreview}
                  sources={rawSources}
                  activeRawPanel={activeRawPanel}
                  onChangeRawPanel={setActiveRawPanel}
                />
              )}
            </div>
          </motion.section>
        </div>
      )}

      {/* Gateway grid detail Drawer */}
      <Drawer open={!!expandedGoal} onOpenChange={(open) => { if (!open) setExpandedGoal(null); }}>
        <DrawerContent
          className="max-h-[85vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{selectedBasket?.label || "Goal"}</DrawerTitle>
            <DrawerDescription>Goal detail view</DrawerDescription>
          </DrawerHeader>

          {selectedApiGoal && selectedVisual && selectedBasket && (
            <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <img src={selectedVisual.image} alt={selectedBasket.label} width={32} height={32} className="w-8 h-8 object-contain" />
                  <span className="text-display text-lg text-foreground font-semibold">{selectedBasket.label}</span>
                  <span className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
                    selectedStatus === "Alert" ? "bg-rose-50 text-rose-400"
                    : selectedStatus === "Watch" ? "bg-amber-50 text-amber-500"
                    : "bg-emerald-50 text-emerald-500"
                  }`}>{selectedStatus}</span>
                </div>
                <span className={`text-display text-lg font-semibold ${
                  selectedStatus === "Alert" ? "text-rose-400"
                  : selectedStatus === "Watch" ? "text-amber-500"
                  : "text-emerald-500"
                }`}>{selectedVisual.pct}%</span>
              </div>

              <div className="w-full h-2 rounded-full bg-foreground/5 mb-4 overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${statusBarColor[selectedStatus]}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${selectedVisual.pct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              </div>

              <p className="text-sm text-foreground/80 mb-4">
                {selectedApiGoal.summary || selectedApiGoal.title}
              </p>

              <div className="w-full h-px bg-foreground/10 mb-4" />

              <h3 className="text-xs font-semibold text-emerald-500 uppercase tracking-wider mb-3">
                AI Weekly Actions
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedVisual.weeklyActions.map((action, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" />
                    <span className="text-sm text-foreground/80 leading-snug">{action}</span>
                  </div>
                ))}
              </div>

              <h3 className="text-xs font-semibold text-amber-500 uppercase tracking-wider mb-3">
                Monitoring
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedVisual.monitoring.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400 mt-1 shrink-0 animate-pulse" />
                    <span className="text-sm text-foreground/75 leading-snug">{item}</span>
                  </div>
                ))}
              </div>

              <h3 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-3">
                AI wants to know
              </h3>
              <div className="space-y-2.5 mb-5">
                {selectedVisual.aiQuestions.map((q, i) => (
                  <button
                    key={i}
                    className="w-full flex items-center gap-3 p-3.5 rounded-2xl border border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.07] active:bg-foreground/[0.1] transition-all text-left group"
                  >
                    <div className="w-8 h-8 rounded-full bg-foreground flex items-center justify-center shrink-0">
                      <Mic size={14} className="text-background" />
                    </div>
                    <span className="text-sm text-foreground/80 leading-snug flex-1">{q}</span>
                    <ArrowRightCircle size={14} className="text-foreground shrink-0" />
                  </button>
                ))}
              </div>

              <button className="w-full py-3.5 rounded-2xl bg-foreground/[0.04] text-sm text-foreground/50 font-medium hover:bg-foreground/[0.07] transition-colors">
                Lock Goals — AI watches only, no modify
              </button>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
