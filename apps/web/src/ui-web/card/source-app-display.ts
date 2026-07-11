import {
  Brain,
  Globe,
  SlidersHorizontal,
  Smartphone,
  Target,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  sourceAppMeta,
  type SourceBrand,
  type SourceIconKey,
} from "@pin-ai/core";
import i18n from "../i18n";

export { reasoningStepLabel } from "@pin-ai/core";

/** core 语义 iconKey → lucide web 图标(内部层 mono 图标)。 */
const SOURCE_ICONS: Record<SourceIconKey, LucideIcon> = {
  web: Globe,
  memory: Brain,
  device: Smartphone,
  profile: UserRound,
  goal: Target,
  preference: SlidersHorizontal,
};

export interface SourceAppDisplay {
  brand: SourceBrand | null;
  label: string;
  Icon?: LucideIcon;
}

export function sourceAppDisplay(slug: string): SourceAppDisplay {
  const { brand, label, iconKey, labelKey } = sourceAppMeta(slug);
  // 普通词走 i18n;品牌词(无 labelKey)保留英文 brand 名。
  const resolvedLabel = labelKey ? i18n.t(`card:sourceApp.${labelKey}`) : label;
  return iconKey
    ? { brand, label: resolvedLabel, Icon: SOURCE_ICONS[iconKey] }
    : { brand, label: resolvedLabel };
}
