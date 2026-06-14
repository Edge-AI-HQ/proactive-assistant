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
  const { brand, label, iconKey } = sourceAppMeta(slug);
  return iconKey ? { brand, label, Icon: SOURCE_ICONS[iconKey] } : { brand, label };
}
