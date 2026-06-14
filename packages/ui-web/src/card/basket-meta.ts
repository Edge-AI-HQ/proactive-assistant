import {
  Briefcase, Heart, Users, TrendingUp, Sprout, Sparkles,
  type LucideIcon,
} from "lucide-react";
import { basketCategory, type BasketIconKey } from "@pin-ai/core";

export interface BasketMeta {
  icon: LucideIcon;
  label: string;
}

/** core 语义 iconKey → lucide web 图标。RN 同名绑定用 lucide-react-native。 */
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
  const { iconKey, label } = basketCategory(key);
  return { icon: BASKET_ICONS[iconKey], label };
}
