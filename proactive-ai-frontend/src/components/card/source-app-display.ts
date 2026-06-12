import {
  Brain,
  Globe,
  SlidersHorizontal,
  Smartphone,
  Target,
  UserRound,
  type LucideIcon,
} from "lucide-react";

/* slug → 展示信息。brand 命中 ChatDetailView.brandSvg 的 8 个品牌;
 * 内部层(web/memory/device/…)用 lucide mono 图标;未知 slug 首字母 chip。
 * slug 表与后端 generator.py 的 _CITATION_TOKEN_TO_APP 同源。 */
export interface SourceAppDisplay {
  brand:
    | "gmail"
    | "gcal"
    | "gdrive"
    | "gdocs"
    | "gsheets"
    | "slack"
    | "notion"
    | "linear"
    | null;
  label: string;
  Icon?: LucideIcon;
}

const SOURCE_APP_DISPLAY: Record<string, SourceAppDisplay> = {
  gmail: { brand: "gmail", label: "Gmail" },
  gcal: { brand: "gcal", label: "Calendar" },
  slack: { brand: "slack", label: "Slack" },
  notion: { brand: "notion", label: "Notion" },
  gdrive: { brand: "gdrive", label: "Drive" },
  gdocs: { brand: "gdocs", label: "Docs" },
  gsheets: { brand: "gsheets", label: "Sheets" },
  linear: { brand: "linear", label: "Linear" },
  web: { brand: null, label: "Web", Icon: Globe },
  memory: { brand: null, label: "Memory", Icon: Brain },
  device: { brand: null, label: "Phone", Icon: Smartphone },
  profile: { brand: null, label: "Profile", Icon: UserRound },
  goal: { brand: null, label: "Goal", Icon: Target },
  preference: { brand: null, label: "Preference", Icon: SlidersHorizontal },
};

export function sourceAppDisplay(slug: string): SourceAppDisplay {
  const known = SOURCE_APP_DISPLAY[slug];
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
