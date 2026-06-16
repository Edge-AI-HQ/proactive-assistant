/**
 * 卡片/引用来源 slug → 展示元数据。平台无关纯数据 + 归一化。
 *
 * `brand` 命中各端的品牌 SVG(web=ChatDetailView.brandSvg 的 8 个品牌),已是平台
 * 中立字符串。内部层(web/memory/device/…)用 `iconKey` 由各端绑定 mono 图标
 * (web: ui-web/card/source-app-display)。slug 表与后端 generator.py 的
 * `_CITATION_TOKEN_TO_APP` 同源。
 */

export type SourceBrand =
  | "gmail"
  | "gcal"
  | "gdrive"
  | "gdocs"
  | "gsheets"
  | "slack"
  | "notion"
  | "linear";

/** 内部层语义图标键。各端据此绑定 mono 图标。 */
export type SourceIconKey =
  | "web"
  | "memory"
  | "device"
  | "profile"
  | "goal"
  | "preference";

/**
 * 语义文案键。各端绑 i18n(web: card.json `sourceApp.*`)。与 `label`(英文回落)
 * 并存:普通词 slug 给 `labelKey`,品牌词(gmail/slack/notion/linear)不给——
 * 保留品牌英文名,不翻译。
 */
export type SourceLabelKey =
  | "calendar"
  | "drive"
  | "docs"
  | "sheets"
  | "web"
  | "memory"
  | "phone"
  | "profile"
  | "goal"
  | "preference";

export interface SourceAppMeta {
  brand: SourceBrand | null;
  label: string;
  iconKey?: SourceIconKey;
  /** i18n 键(card.json sourceApp.*)。品牌词不给,回落英文 brand 名。 */
  labelKey?: SourceLabelKey;
}

const SOURCE_APP_META: Record<string, SourceAppMeta> = {
  gmail: { brand: "gmail", label: "Gmail" },
  gcal: { brand: "gcal", label: "Calendar", labelKey: "calendar" },
  slack: { brand: "slack", label: "Slack" },
  notion: { brand: "notion", label: "Notion" },
  gdrive: { brand: "gdrive", label: "Drive", labelKey: "drive" },
  gdocs: { brand: "gdocs", label: "Docs", labelKey: "docs" },
  gsheets: { brand: "gsheets", label: "Sheets", labelKey: "sheets" },
  linear: { brand: "linear", label: "Linear" },
  web: { brand: null, label: "Web", iconKey: "web", labelKey: "web" },
  memory: { brand: null, label: "Memory", iconKey: "memory", labelKey: "memory" },
  device: { brand: null, label: "Phone", iconKey: "device", labelKey: "phone" },
  profile: { brand: null, label: "Profile", iconKey: "profile", labelKey: "profile" },
  goal: { brand: null, label: "Goal", iconKey: "goal", labelKey: "goal" },
  preference: { brand: null, label: "Preference", iconKey: "preference", labelKey: "preference" },
};

export function sourceAppMeta(slug: string): SourceAppMeta {
  const known = SOURCE_APP_META[slug];
  if (known) return known;
  return { brand: null, label: slug.charAt(0).toUpperCase() + slug.slice(1) };
}

const REASONING_STEP_LABELS: Record<string, string> = {
  observed: "Observed",
  cross_referenced: "Cross-referenced",
  pattern_matched: "Pattern matched",
  flagged: "Flagged",
  decided: "Decided",
};

export function reasoningStepLabel(label: string): string {
  return (
    REASONING_STEP_LABELS[label] ??
    label.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

/** 语义文案键(card.json `reasoningStep.*`)。各端绑 i18n。 */
export type ReasoningStepKey =
  | "observed"
  | "crossReferenced"
  | "patternMatched"
  | "flagged"
  | "decided";

// 后端 snake_case 枚举 → card.json camelCase 键。
const REASONING_STEP_KEYS: Record<string, ReasoningStepKey> = {
  observed: "observed",
  cross_referenced: "crossReferenced",
  pattern_matched: "patternMatched",
  flagged: "flagged",
  decided: "decided",
};

/**
 * 已知 reasoning step → i18n 键(card.json reasoningStep.*);未知返回 null。
 * 各端:命中走 i18n,未命中回落 `reasoningStepLabel`(英文 prettify)。
 */
export function reasoningStepKey(label: string): ReasoningStepKey | null {
  return REASONING_STEP_KEYS[label] ?? null;
}
