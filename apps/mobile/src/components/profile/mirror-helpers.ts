/**
 * PROFILE 屏纯 helper——web `packages/ui-web/src/profile/mirror.tsx` 的 RN 复制版。
 * mirror.tsx 是 React DOM 介质层（RN 用不了），其纯派生逻辑耦合 web 介质
 * （import.meta.env.BASE_URL / lucide-react），按 live-session 先例
 * **复制进 RN 做平台适配**：i18n → 照 dev 用 i18n.t（key 同 mirror.tsx，经
 * ../../i18n 的 RN 单例）、图片 → require 静态资源、图标 → lucide-react-native
 * （core basket-category 注释指定的「RN 同名绑定」）。数据 hook 不复制，照用
 * @pin-ai/state。
 */
import type { ImageSourcePropType } from "react-native";
import {
  Briefcase,
  Heart,
  Sparkles,
  Sprout,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react-native";
import {
  basketCategory,
  type BasketIconKey,
  type Goal,
  type Memory,
  type ProfileSnapshot,
} from "@pin-ai/core";

import i18n from "../../i18n";
import type profileEn from "../../../../../packages/ui-kit/src/locales/en/profile.json";

// ---------------------------------------------------------------------------
// Basket icons —— web packages/ui-web/src/card/basket-meta.ts 的 RN 同名绑定
// ---------------------------------------------------------------------------

export interface BasketMeta {
  icon: LucideIcon;
  label: string;
  /** 语言无关的类目键（work/health/…）——用于布局判定（如 Growth 配图高度），
   *  不要用 label 判定：label 已本地化，字面比较会在非 en 语言失效。 */
  iconKey: BasketIconKey;
}

const BASKET_ICONS: Record<BasketIconKey, LucideIcon> = {
  work: Briefcase,
  health: Heart,
  family: Users,
  finance: TrendingUp,
  growth: Sprout,
  life: Sparkles,
  general: Sparkles,
};

export function basketMeta(key: string): BasketMeta {
  const { iconKey } = basketCategory(key);
  // label 走 i18n（core basketCategory().label 是硬编码英文）；iconKey 值域
  // work/health/family/finance/growth/life/general 与 profile:baskets.* 完全对应。
  // 渲染时调用（见下方 GoalCard / GoalDetailSheet），随语言切换即时更新。
  return { icon: BASKET_ICONS[iconKey], label: i18n.t(`profile:baskets.${iconKey}`), iconKey };
}

// ---------------------------------------------------------------------------
// Goal visual meta / status —— mirror.tsx 同名逻辑
// ---------------------------------------------------------------------------

export type VisualStatus = "Normal" | "Alert" | "Watch";
export type ProfileGroupKey = "facts" | "preferences" | "constraints" | "metadata";

/** Canonical goal-meta key——demo action/monitoring/question 列表在 profile.json
 *  的 `goalMeta.<key>` 下（demo 列表，非后端数据）。`null` = 无列表（fallback）。 */
type GoalMetaKey = keyof typeof profileEn.goalMeta;

export interface GoalVisualMeta {
  image: ImageSourcePropType;
  pct: number;
  metaKey: GoalMetaKey | null;
}

const GOAL_IMAGES = {
  work: require("../../assets/goals/goal-work.png") as ImageSourcePropType,
  health: require("../../assets/goals/goal-health.png") as ImageSourcePropType,
  finance: require("../../assets/goals/goal-finance.png") as ImageSourcePropType,
  growth: require("../../assets/goals/goal-growth.png") as ImageSourcePropType,
  family: require("../../assets/goals/goal-family.png") as ImageSourcePropType,
  life: require("../../assets/goals/goal-life.png") as ImageSourcePropType,
};

/** web GOAL_VISUAL_META：pct 是写死的 demo 进度（web 亦然），image 换成 require。 */
const GOAL_VISUAL_META: Record<string, GoalVisualMeta> = {
  "career-growth": { image: GOAL_IMAGES.work, pct: 62, metaKey: "work" },
  work: { image: GOAL_IMAGES.work, pct: 62, metaKey: "work" },
  "stay-healthy": { image: GOAL_IMAGES.health, pct: 35, metaKey: "health" },
  health: { image: GOAL_IMAGES.health, pct: 35, metaKey: "health" },
  "financial-plan": { image: GOAL_IMAGES.finance, pct: 52, metaKey: "finance" },
  finance: { image: GOAL_IMAGES.finance, pct: 52, metaKey: "finance" },
  wealth: { image: GOAL_IMAGES.finance, pct: 52, metaKey: "finance" },
  "learn-and-grow": { image: GOAL_IMAGES.growth, pct: 72, metaKey: "growth" },
  growth: { image: GOAL_IMAGES.growth, pct: 72, metaKey: "growth" },
  relationships: { image: GOAL_IMAGES.family, pct: 50, metaKey: "family" },
  family: { image: GOAL_IMAGES.family, pct: 50, metaKey: "family" },
  "life-balance": { image: GOAL_IMAGES.life, pct: 40, metaKey: "life" },
  life: { image: GOAL_IMAGES.life, pct: 40, metaKey: "life" },
};

const FALLBACK_VISUAL: GoalVisualMeta = {
  image: GOAL_IMAGES.life,
  pct: 50,
  metaKey: null,
};

/** goal 抽屉的本地化 demo 列表；fallback（metaKey=null）给空数组。 */
export function goalMetaLists(metaKey: GoalMetaKey | null): {
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

export function getVisualMeta(key: string): GoalVisualMeta {
  return GOAL_VISUAL_META[key] ?? GOAL_VISUAL_META[key.split("-")[0]] ?? FALLBACK_VISUAL;
}

export function priorityToStatus(priority: string): VisualStatus {
  if (priority === "high") return "Alert";
  if (priority === "low") return "Watch";
  return "Normal";
}

/** starter goal 的 i18n key（= profile.json `starterGoals.<key>`，6 条 title 的本地化真源）。 */
type StarterGoalKey = keyof typeof profileEn.starterGoals;

/** backend `orchestration/default_goals.py` `_STARTER_GOALS` 逐字（key/title/priority）——
 *  prod 给每个新用户种的就是这 6 条，也是「Goals 只有 6 张、类目 Work/Health…」的数据真源。
 *  title 是英文数据真源（= profile.json starterGoals.* 的 en 值），实际展示走 i18n。 */
const STARTER_GOALS: readonly { key: StarterGoalKey; title: string; priority: string }[] = [
  { key: "career-growth", title: "Advance career and professional skills", priority: "high" },
  { key: "stay-healthy", title: "Maintain consistent exercise and healthy habits", priority: "medium" },
  { key: "financial-plan", title: "Grow savings and make smart financial decisions", priority: "medium" },
  { key: "learn-and-grow", title: "Dedicate time to learning new skills and ideas", priority: "medium" },
  { key: "relationships", title: "Stay connected with family and close friends", priority: "medium" },
  { key: "life-balance", title: "Protect personal time and avoid burnout", priority: "high" },
];

/**
 * Goals 网格归一化：永远渲染 6 个规范 basket 槽位（= prod 种子展示效果）。
 * 后端 goal 经 basketCategory 归类，命中槽位的用真实 goal（summary/priority
 * 透出，prod 数据即此路径）；没命中的槽位用 _STARTER_GOALS 同款兜底；归不进
 * 6 类（General）的不展示。
 *
 * ⚠️ 有意偏离 web mirror.tsx 的「逐 goal 渲染」（用户 2026-07-01 定）：dev 库
 * 脏 key 会让逐 goal 渲染全落 General，正确展示以 prod（种子数据）为准，只改
 * RN 端、不动 dev。
 */
export function canonicalBasketGoals(goals: Goal[]): Goal[] {
  return STARTER_GOALS.map((starter) => {
    const slotIcon = basketCategory(starter.key).iconKey;
    const match = goals.find((goal) => basketCategory(goal.key).iconKey === slotIcon);
    return (
      match ?? {
        id: `starter-${starter.key}`,
        user_id: "",
        key: starter.key,
        // 兜底 starter 的 title 走 i18n（starter.key 值域与 profile:starterGoals.* 一一对应）；
        // 命中真实后端 goal 时用 match（title 是后端数据、不翻译）。渲染时调用，随语言切换更新。
        title: i18n.t(`profile:starterGoals.${starter.key}`),
        priority: starter.priority,
        status: "active",
        summary: null,
        created_at: "",
        updated_at: "",
      }
    );
  });
}

const STATUS_LABEL_KEY: Record<VisualStatus, "normal" | "alert" | "watch"> = {
  Normal: "normal",
  Alert: "alert",
  Watch: "watch",
};

/** web statusLabel 同款——经 i18n goalsView.status.*。 */
export function statusLabel(status: VisualStatus): string {
  return i18n.t(`profile:goalsView.status.${STATUS_LABEL_KEY[status]}`);
}

// 文案在 en/profile.json goalsView.profileGroups.*；此数组只定展示顺序（同 web）。
export const PROFILE_GROUP_META = [
  { key: "facts" },
  { key: "preferences" },
  { key: "constraints" },
] as const;

// ---------------------------------------------------------------------------
// Pure derivations —— mirror.tsx 同名逻辑
// ---------------------------------------------------------------------------

/** snake_case → "UPPER SPACED"。 */
export function prettyFieldKey(key: string): string {
  return key.replace(/_+/g, " ").trim().toUpperCase();
}

export function formatValue(value: unknown): string {
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

  return (
    firstTextValue(profile.summary) ??
    firstTextValue(profile.facts) ??
    firstTextValue(profile.preferences) ??
    firstTextValue(profile.constraints) ??
    firstTextValue(profile.metadata) ??
    fallback
  );
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

export function formatClockTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** 按相对日 label 分组（TODAY / YESTERDAY / "MMM D"）。memories 按 created_at 降序到达，插入序即展示序。 */
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
    const label =
      key === todayKey
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
