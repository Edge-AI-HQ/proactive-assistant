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

export interface SourceAppMeta {
  brand: SourceBrand | null;
  label: string;
  iconKey?: SourceIconKey;
}

const SOURCE_APP_META: Record<string, SourceAppMeta> = {
  gmail: { brand: "gmail", label: "Gmail" },
  gcal: { brand: "gcal", label: "Calendar" },
  slack: { brand: "slack", label: "Slack" },
  notion: { brand: "notion", label: "Notion" },
  gdrive: { brand: "gdrive", label: "Drive" },
  gdocs: { brand: "gdocs", label: "Docs" },
  gsheets: { brand: "gsheets", label: "Sheets" },
  linear: { brand: "linear", label: "Linear" },
  web: { brand: null, label: "Web", iconKey: "web" },
  memory: { brand: null, label: "Memory", iconKey: "memory" },
  device: { brand: null, label: "Phone", iconKey: "device" },
  profile: { brand: null, label: "Profile", iconKey: "profile" },
  goal: { brand: null, label: "Goal", iconKey: "goal" },
  preference: { brand: null, label: "Preference", iconKey: "preference" },
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
