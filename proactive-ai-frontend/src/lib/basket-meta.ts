import {
  Briefcase, Heart, Users, TrendingUp, Sprout, Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface BasketMeta {
  icon: LucideIcon;
  label: string;
}

const BASKET_ICONS: Record<string, BasketMeta> = {
  work:    { icon: Briefcase,   label: "Work" },
  health:  { icon: Heart,       label: "Health" },
  family:  { icon: Users,       label: "Family" },
  wealth:  { icon: TrendingUp,  label: "Finance" },
  finance: { icon: TrendingUp,  label: "Finance" },
  growth:  { icon: Sprout,      label: "Growth" },
  life:    { icon: Sparkles,    label: "Life" },
};

const FALLBACK: BasketMeta = { icon: Sparkles, label: "General" };

export function basketMeta(key: string): BasketMeta {
  return BASKET_ICONS[key?.toLowerCase()] ?? FALLBACK;
}
