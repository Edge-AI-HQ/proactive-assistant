/**
 * Mirror —— 共享展示层（React DOM，web 双端 apps/web + proactive 复用；RN 用
 * 不了这层，写自己的 UI，只共享 @pin-ai/state 的数据 hook）。
 *
 * 这里只放 profile / memory / goals 的 panel + goal 详情 + 纯派生 helper。
 * server state 在 @pin-ai/state（useProfileSnapshot / useProfileMemories）；
 * ephemeral UI state（tab / openGroups / expandedGoal）留各 app 的 layout shell
 * （apps/web MirrorDesktop、proactive MirrorMobile）。
 */
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRightCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mic,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "../ui/drawer";
import i18n from "../i18n";
import type profileEn from "../../../ui-kit/src/locales/en/profile.json";
import { basketMeta } from "../card/basket-meta";
import { useMediaQuery } from "../lib/use-media-query";
import { Text } from "../primitives/Text";
import type { Goal, Memory, ProfileSnapshot } from "@pin-ai/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisualStatus = "Normal" | "Alert" | "Watch";
export type ProfileGroupKey = "facts" | "preferences" | "constraints" | "metadata";

/** Canonical goal-meta key — the demo action/monitoring/question lists live
 *  in `profile.json` under `goalMeta.<key>`. `null` = no lists (fallback). */
type GoalMetaKey = keyof typeof profileEn.goalMeta;

export interface GoalVisualMeta {
  image: string;
  pct: number;
  metaKey: GoalMetaKey | null;
}

// ---------------------------------------------------------------------------
// Goal visual meta / status
// ---------------------------------------------------------------------------

const BASE = import.meta.env.BASE_URL;

const GOAL_VISUAL_META: Record<string, GoalVisualMeta> = {
  "career-growth": { image: `${BASE}goal-work.png`, pct: 62, metaKey: "work" },
  work: { image: `${BASE}goal-work.png`, pct: 62, metaKey: "work" },
  "stay-healthy": { image: `${BASE}goal-health.png`, pct: 35, metaKey: "health" },
  health: { image: `${BASE}goal-health.png`, pct: 35, metaKey: "health" },
  "financial-plan": { image: `${BASE}goal-finance.png`, pct: 52, metaKey: "finance" },
  finance: { image: `${BASE}goal-finance.png`, pct: 52, metaKey: "finance" },
  wealth: { image: `${BASE}goal-finance.png`, pct: 52, metaKey: "finance" },
  "learn-and-grow": { image: `${BASE}goal-growth.png`, pct: 72, metaKey: "growth" },
  growth: { image: `${BASE}goal-growth.png`, pct: 72, metaKey: "growth" },
  relationships: { image: `${BASE}goal-family.png`, pct: 50, metaKey: "family" },
  family: { image: `${BASE}goal-family.png`, pct: 50, metaKey: "family" },
  "life-balance": { image: `${BASE}goal-life.png`, pct: 40, metaKey: "life" },
  life: { image: `${BASE}goal-life.png`, pct: 40, metaKey: "life" },
};

const FALLBACK_VISUAL: GoalVisualMeta = {
  image: `${BASE}goal-life.png`,
  pct: 50,
  metaKey: null,
};

/** Localized demo lists for a goal's drawer. Empty arrays for the fallback. */
function goalMetaLists(metaKey: GoalMetaKey | null): {
  weeklyActions: string[];
  monitoring: string[];
  aiQuestions: string[];
} {
  if (!metaKey) return { weeklyActions: [], monitoring: [], aiQuestions: [] };
  return {
    weeklyActions: i18n.t(`profile:goalMeta.${metaKey}.weeklyActions`, { returnObjects: true }) as string[], // returnObjects 返回 i18next $SpecialObject,数组形态需断言
    monitoring: i18n.t(`profile:goalMeta.${metaKey}.monitoring`, { returnObjects: true }) as string[], // returnObjects 返回 i18next $SpecialObject,数组形态需断言
    aiQuestions: i18n.t(`profile:goalMeta.${metaKey}.aiQuestions`, { returnObjects: true }) as string[], // returnObjects 返回 i18next $SpecialObject,数组形态需断言
  };
}

function getVisualMeta(key: string): GoalVisualMeta {
  return GOAL_VISUAL_META[key] ?? GOAL_VISUAL_META[key.split("-")[0]] ?? FALLBACK_VISUAL;
}

function priorityToStatus(priority: string): VisualStatus {
  if (priority === "high") return "Alert";
  if (priority === "low") return "Watch";
  return "Normal";
}

const statusPillColor: Record<VisualStatus, string> = {
  Normal: "bg-emerald-500/10 text-emerald-700",
  Alert: "bg-rose-500/10 text-rose-700",
  Watch: "bg-amber-500/10 text-amber-700",
};

const statusBarColor: Record<VisualStatus, string> = {
  Normal: "bg-emerald-400/50",
  Alert: "bg-rose-400/50",
  Watch: "bg-amber-400/50",
};

const STATUS_LABEL_KEY: Record<VisualStatus, "normal" | "alert" | "watch"> = {
  Normal: "normal",
  Alert: "alert",
  Watch: "watch",
};

function statusLabel(status: VisualStatus): string {
  return i18n.t(`profile:goalsView.status.${STATUS_LABEL_KEY[status]}`);
}

// Copy lives in profile.json under `goalsView.profileGroups.<key>`; this array
// only fixes the display order.
export const PROFILE_GROUP_META = [
  { key: "facts" },
  { key: "preferences" },
  { key: "constraints" },
] as const;

// ---------------------------------------------------------------------------
// Pure derivations (RN-reusable shape; kept here for the web panels)
// ---------------------------------------------------------------------------

/** Normalize a profile field key for display (snake_case → "UPPER SPACED"). */
function prettyFieldKey(key: string): string {
  return key.replace(/_+/g, " ").trim().toUpperCase();
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

const PROFILE_SUMMARY_KEYS = [
  "summary",
  "identity",
  "identify",
  "bio",
  "about",
  "description",
  "persona",
] as const;

function firstTextValue(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (Array.isArray(value)) {
    const text = value
      .map(firstTextValue)
      .filter((item): item is string => Boolean(item))
      .join(" ");
    return text.trim() || null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of PROFILE_SUMMARY_KEYS) {
    const text = firstTextValue(record[key]);
    if (text) return text;
  }
  return null;
}

export function profileSummaryText(profile: ProfileSnapshot["profile"]): string {
  const fallback = i18n.t("profile:goalsView.noSummary");
  if (!profile) return fallback;

  return firstTextValue(profile.summary)
    ?? firstTextValue(profile.facts)
    ?? firstTextValue(profile.preferences)
    ?? firstTextValue(profile.constraints)
    ?? firstTextValue(profile.metadata)
    ?? fallback;
}

export interface MemoryGroup {
  key: string;
  label: string;
  items: Memory[];
}

function dayBucketKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function formatDayLabel(d: Date, now: Date): string {
  const sameYear = d.getFullYear() === now.getFullYear();
  return d
    .toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    })
    .toUpperCase();
}

function formatClockTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Group memories by relative day label (TODAY / YESTERDAY / "MMM D"). Memories
 *  arrive sorted desc by created_at, so insertion order is preserved. */
export function groupMemoriesByDay(memories: Memory[]): MemoryGroup[] {
  const now = new Date();
  const todayKey = dayBucketKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayBucketKey(yesterday);

  const byKey = new Map<string, MemoryGroup>();
  for (const memory of memories) {
    const ref = memory.occurred_at ?? memory.created_at;
    const date = ref ? new Date(ref) : null;
    if (!date || Number.isNaN(date.getTime())) {
      const fallback = byKey.get("unknown") ?? {
        key: "unknown",
        label: i18n.t("profile:goalsView.memory.unknownDate"),
        items: [],
      };
      fallback.items.push(memory);
      byKey.set("unknown", fallback);
      continue;
    }
    const key = dayBucketKey(date);
    const label = key === todayKey
      ? i18n.t("profile:goalsView.memory.today")
      : key === yesterdayKey
        ? i18n.t("profile:goalsView.memory.yesterday")
        : formatDayLabel(date, now);
    const group = byKey.get(key) ?? { key, label, items: [] };
    group.items.push(memory);
    byKey.set(key, group);
  }
  return Array.from(byKey.values());
}

const sectionMotion = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24 },
};

// ---------------------------------------------------------------------------
// Shared panels
// ---------------------------------------------------------------------------

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.03] px-4 py-5 text-center">
      <p className="text-sm font-medium text-foreground/70">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground/45">{description}</p>
    </div>
  );
}

/** Identity summary card — label + name + summary. No avatar (intentional:
 *  there is no per-user avatar in the real profile). */
export function IdentitySummaryCard({ profile }: { profile: ProfileSnapshot["profile"] }) {
  const { t } = useTranslation("profile");
  return (
    <motion.section {...sectionMotion} className="glass-card-strong p-5">
      <Text variant="caption" weight="semibold" className="block uppercase tracking-[0.18em] text-foreground/45">
        {t("goalsView.identityLabel")}
      </Text>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
        {profile?.display_name?.trim() || t("goalsView.unnamedUser")}
      </h2>
      <Text variant="bodySm" className="block mt-2 leading-6 text-foreground/65 line-clamp-6">
        {profileSummaryText(profile)}
      </Text>
    </motion.section>
  );
}

/** Segmented sub-tab button used by the mobile Profile/Memory switcher. */
export function WorkbenchTabButton({
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
      aria-pressed={active}
      className={`glass-card p-4 text-left transition-all ${active ? "bg-foreground text-background" : ""}`}
    >
      <div className={`text-micro uppercase tracking-[0.16em] ${active ? "text-background/60" : "text-foreground/35"}`}>
        {label}
      </div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </button>
  );
}

function ProfileGroupCard({
  groupKey,
  values,
  expanded,
  onToggle,
}: {
  groupKey: (typeof PROFILE_GROUP_META)[number]["key"];
  values: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("profile");
  const entries = Object.entries(values);

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t(`goalsView.profileGroups.${groupKey}.title`)}
            </span>
            <Text variant="micro" weight="medium" className="rounded-full bg-foreground/5 px-2 py-0.5 text-foreground/45">
              {entries.length}
            </Text>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/42">
            {t(`goalsView.profileGroups.${groupKey}.description`)}
          </p>
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
            <div className="border-t border-foreground/8 px-4 pb-4 pt-3">
              {entries.length === 0 ? (
                <EmptyState
                  title={t(`goalsView.profileGroups.${groupKey}.emptyTitle`)}
                  description={t("goalsView.groupEmptyDescription")}
                />
              ) : (
                <div className="space-y-1">
                  {entries.map(([key, value]) => (
                    <div key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1">
                      <Text variant="micro" weight="semibold" className="uppercase tracking-[0.12em] text-foreground/45">
                        {prettyFieldKey(key)}
                      </Text>
                      <span className="min-w-[60%] flex-1 whitespace-pre-wrap break-words text-bodySm leading-5 text-foreground/80">
                        {formatValue(value)}
                      </span>
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

export function ProfilePanel({
  profile,
  openGroups,
  onToggleGroup,
}: {
  profile: ProfileSnapshot["profile"];
  openGroups: Record<ProfileGroupKey, boolean>;
  onToggleGroup: (group: ProfileGroupKey) => void;
}) {
  const { t } = useTranslation("profile");
  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">{t("goalsView.mirror.title")}</h2>
        <Text variant="caption" className="block mt-1 leading-5 text-foreground/42">
          {t("goalsView.mirror.description")}
        </Text>
      </div>

      <div className="space-y-2.5">
        {PROFILE_GROUP_META.map((group) => (
          <ProfileGroupCard
            key={group.key}
            groupKey={group.key}
            values={profile?.[group.key] ?? {}}
            expanded={openGroups[group.key]}
            onToggle={() => onToggleGroup(group.key)}
          />
        ))}
      </div>
    </div>
  );
}

/** One memory row — text first, attribution line underneath. */
function MemoryListItem({ memory }: { memory: Memory }) {
  const { t } = useTranslation("profile");
  const when = memory.occurred_at ?? memory.created_at;
  const time = formatClockTime(when);
  return (
    <div>
      <Text variant="bodySm" className="block leading-6 text-foreground/85">{memory.text}</Text>
      <Text variant="caption" className="block mt-1 text-foreground/45">
        {t("goalsView.memory.inferredFrom", { source: memory.source })}
        {time && ` · ${time}`}
      </Text>
    </div>
  );
}

export function MemoryPanel({
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
  const { t, i18n: i18nInstance } = useTranslation(["profile", "common"]);
  const groups = useMemo(
    () => groupMemoriesByDay(memories),
    [memories, i18nInstance.language],
  );

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">{t("goalsView.memory.title")}</h2>
        <Text variant="caption" className="block mt-1 leading-5 text-foreground/42">
          {t("goalsView.memory.description")}
        </Text>
      </div>
      <div className="space-y-5">
        {memories.length === 0 ? (
          <EmptyState
            title={t("goalsView.memory.emptyTitle")}
            description={t("goalsView.memory.emptyDescription")}
          />
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className="mb-2 flex items-baseline gap-2 px-1">
                <Text variant="micro" weight="semibold" className="uppercase tracking-[0.16em] text-foreground/45">
                  {group.label}
                </Text>
                <Text variant="micro" weight="medium" className="text-foreground/30">{group.items.length}</Text>
              </div>
              <div className="space-y-3">
                {group.items.map((memory) => (
                  <MemoryListItem key={memory.id} memory={memory} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-white/45 px-3 py-2 ring-1 ring-white/60">
        <Text variant="caption" className="block text-foreground/45 tabular-nums">
          {total === 0
            ? t("goalsView.memory.countZero")
            : t("goalsView.memory.countOfTotal", { shown: memories.length, total })}
        </Text>
        <button
          type="button"
          disabled={!hasMore || loadingMore}
          onClick={onLoadMore}
          className="flex items-center gap-1.5 rounded-xl bg-foreground/5 px-3 py-1.5 text-caption font-medium text-foreground/55 transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loadingMore ? (
            <>
              <Loader2 size={12} className="animate-spin" /> {t("common:status.loading")}
            </>
          ) : hasMore ? (
            t("goalsView.memory.loadMore")
          ) : (
            t("goalsView.memory.endOfList")
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Goals — grid + detail
// ---------------------------------------------------------------------------

/** The goals grid (Identity/Goals tab → Goals). Tapping a card calls onOpen
 *  with the goal key; the host owns the expanded-goal state + <GoalDetail>. */
export function GoalsGrid({ goals, onOpen }: { goals: Goal[]; onOpen: (key: string) => void }) {
  const { t } = useTranslation("profile");
  return (
    <motion.section id="profile-section-goals" {...sectionMotion} className="glass-card-strong p-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">{t("goalsView.goals.title")}</h2>
        <Text variant="caption" className="block mt-1 leading-5 text-foreground/42">
          {t("goalsView.goals.description")}
        </Text>
      </div>
      {goals.length === 0 ? (
        <EmptyState
          title={t("goalsView.goals.emptyTitle")}
          description={t("goalsView.goals.emptyDescription")}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {goals.map((goal) => {
            const visual = getVisualMeta(goal.key);
            const basket = basketMeta(goal.key);
            const status = priorityToStatus(goal.priority);
            const Icon = basket.icon;

            return (
              <button
                key={goal.key}
                type="button"
                className="glass-card cursor-pointer overflow-hidden text-left transition-transform active:scale-[0.98]"
                onClick={() => onOpen(goal.key)}
              >
                <div className="flex h-24 items-center justify-center bg-foreground/[0.03]">
                  <img
                    src={visual.image}
                    alt={basket.label}
                    className={`w-auto object-contain ${basket.label === "Growth" ? "h-[62%]" : "h-[85%]"}`}
                  />
                </div>
                <div className="p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Icon size={16} className="text-foreground" />
                    <span className="text-sm font-semibold text-foreground">{basket.label}</span>
                  </div>
                  <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                    <div className={`h-full rounded-full ${statusBarColor[status]}`} style={{ width: `${visual.pct}%` }} />
                  </div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-lg font-semibold tabular-nums text-foreground">{visual.pct}%</span>
                    <span className={`rounded-full px-2 py-0.5 text-micro font-medium ${statusPillColor[status]}`}>
                      {statusLabel(status)}
                    </span>
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <Text variant="caption" className="block line-clamp-2 leading-snug text-foreground/55">
                      {goal.summary || goal.title}
                    </Text>
                    <ChevronRight size={14} className="shrink-0 text-foreground/30" />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </motion.section>
  );
}

/**
 * Goal 详情正文（header / 进度 / summary / AI Weekly Actions / Monitoring /
 * AI wants to know / Lock）—— 宽屏居中 popup 与窄屏底部 Drawer 共用同一份。
 * hideHeaderImage：popup 顶部已有 hero 配图横幅，header 行不再重复小图。
 */
function GoalDetailBody({
  apiGoal,
  visual,
  basket,
  status,
  hideHeaderImage,
}: {
  apiGoal: Goal;
  visual: GoalVisualMeta;
  basket: ReturnType<typeof basketMeta>;
  status: VisualStatus;
  hideHeaderImage?: boolean;
}) {
  const { t } = useTranslation("profile");
  const lists = goalMetaLists(visual.metaKey);
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {!hideHeaderImage && (
            <img src={visual.image} alt={basket.label} width={32} height={32} className="w-8 h-8 object-contain" />
          )}
          <span className="text-display text-lg text-foreground font-semibold">{basket.label}</span>
          <span className={`text-caption font-medium px-2.5 py-0.5 rounded-full ${
            status === "Alert" ? "bg-rose-50 text-rose-400"
            : status === "Watch" ? "bg-amber-50 text-amber-500"
            : "bg-emerald-50 text-emerald-500"
          }`}>{statusLabel(status)}</span>
        </div>
        <span className={`text-display text-lg font-semibold ${
          status === "Alert" ? "text-rose-400"
          : status === "Watch" ? "text-amber-500"
          : "text-emerald-500"
        }`}>{visual.pct}%</span>
      </div>

      <div className="w-full h-2 rounded-full bg-foreground/5 mb-4 overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${statusBarColor[status]}`}
          initial={{ width: 0 }}
          animate={{ width: `${visual.pct}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>

      <p className="text-sm text-foreground/80 mb-4">
        {apiGoal.summary || apiGoal.title}
      </p>

      <div className="w-full h-px bg-foreground/10 mb-4" />

      <h3 className="text-xs font-semibold text-emerald-500 uppercase tracking-wider mb-3">
        {t("goalsView.goals.weeklyActions")}
      </h3>
      <div className="space-y-2.5 mb-5">
        {lists.weeklyActions.map((action, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" />
            <span className="text-sm text-foreground/80 leading-snug">{action}</span>
          </div>
        ))}
      </div>

      <h3 className="text-xs font-semibold text-amber-500 uppercase tracking-wider mb-3">
        {t("goalsView.goals.monitoring")}
      </h3>
      <div className="space-y-2.5 mb-5">
        {lists.monitoring.map((item, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-400 mt-1 shrink-0 animate-pulse" />
            <span className="text-sm text-foreground/75 leading-snug">{item}</span>
          </div>
        ))}
      </div>

      <h3 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-3">
        {t("goalsView.goals.aiWantsToKnow")}
      </h3>
      <div className="space-y-2.5 mb-5">
        {lists.aiQuestions.map((q, i) => (
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
        {t("goalsView.goals.lockGoals")}
      </button>
    </>
  );
}

/**
 * Goal 详情的桌面居中玻璃 popup（宽屏）。经 Portal 渲染到 document.body——
 * 宿主 shell 的 motion 容器有 transform 会成为 fixed 定位的 containing block，
 * 不 Portal 的话 popup 会相对它而非 viewport 居中。Esc / 点击遮罩关闭。
 */
function GoalDetailPopup({
  apiGoal,
  visual,
  basket,
  status,
  onClose,
}: {
  apiGoal: Goal | null;
  visual: GoalVisualMeta | null;
  basket: ReturnType<typeof basketMeta> | null;
  status: VisualStatus;
  onClose: () => void;
}) {
  const { t } = useTranslation("profile");
  const open = !!(apiGoal && visual && basket);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {apiGoal && visual && basket && (
        <>
          <motion.div
            key="goal-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[70] bg-foreground/10 backdrop-blur-sm"
            onClick={onClose}
          />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              key={`goal-popup-${apiGoal.key}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              role="dialog"
              aria-label={t("goalDetail.ariaLabel", { label: basket.label })}
              className="pointer-events-auto w-[600px] max-w-full max-h-[82vh] rounded-3xl overflow-hidden flex flex-col"
              style={{
                background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.75) 0%, hsla(0, 0%, 100%, 0.92) 100%)",
                backdropFilter: "blur(48px) saturate(1.5)",
                WebkitBackdropFilter: "blur(48px) saturate(1.5)",
                border: "1px solid hsla(0, 0%, 100%, 0.55)",
                boxShadow: "0 24px 80px hsl(280 20% 40% / 0.25)",
              }}
            >
              <div className="relative shrink-0 h-36 bg-foreground/[0.03] flex items-center justify-center overflow-hidden">
                <img src={visual.image} alt={basket.label} className="w-auto h-[88%] object-contain" />
                <button
                  onClick={onClose}
                  className="absolute top-3 right-3 p-2 rounded-full bg-white/60 hover:bg-white/85 backdrop-blur-md transition-colors"
                  aria-label={t("goalDetail.close")}
                >
                  <X size={16} strokeWidth={1.8} className="text-foreground/65" />
                </button>
              </div>
              <div className="px-6 pb-6 pt-4 overflow-y-auto">
                <GoalDetailBody apiGoal={apiGoal} visual={visual} basket={basket} status={status} hideHeaderImage />
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * 响应式 goal 详情：宽屏（桌面）居中玻璃 popup，窄屏（iOS / 手机浏览器）底部
 * Drawer——同一份 GoalDetailBody。`detailLayout="drawer"` 强制走 Drawer
 * （proactive 的 mobile shell 用）。`goal=null` 即关闭。
 */
export function GoalDetail({
  goal,
  detailLayout = "auto",
  onClose,
}: {
  goal: Goal | null;
  detailLayout?: "auto" | "drawer";
  onClose: () => void;
}) {
  const { t } = useTranslation("profile");
  const isWideViewport = useMediaQuery("(min-width: 1024px)");
  const visual = goal ? getVisualMeta(goal.key) : null;
  const basket = goal ? basketMeta(goal.key) : null;
  const status = goal ? priorityToStatus(goal.priority) : "Normal";

  if (detailLayout !== "drawer" && isWideViewport) {
    return (
      <GoalDetailPopup
        apiGoal={goal}
        visual={visual}
        basket={basket}
        status={status}
        onClose={onClose}
      />
    );
  }

  return (
    <Drawer open={!!goal} onOpenChange={(open) => { if (!open) onClose(); }}>
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
          <DrawerTitle>{basket?.label || t("goalsView.goals.drawerFallbackTitle")}</DrawerTitle>
          <DrawerDescription>{t("goalsView.goals.drawerDescription")}</DrawerDescription>
        </DrawerHeader>
        {goal && visual && basket && (
          <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
            <GoalDetailBody apiGoal={goal} visual={visual} basket={basket} status={status} />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
