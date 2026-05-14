import {
  BookOpen,
  Briefcase,
  Heart,
  Sparkles,
  Sprout,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { CardCategory } from "@/types/constellation";

export interface CategoryMeta {
  icon: LucideIcon;
  label: string;
  /** Accent for the pill / ring; HSL string (no `hsl()` wrapper). */
  accent: string;
}

export const CATEGORY_META: Record<CardCategory, CategoryMeta> = {
  growth:  { icon: Sprout,     label: "Growth",  accent: "145 60% 50%" },
  work:    { icon: Briefcase,  label: "Work",    accent: "215 70% 60%" },
  finance: { icon: TrendingUp, label: "Finance", accent: "35 90% 55%"  },
  health:  { icon: Heart,      label: "Health",  accent: "0 72% 60%"   },
  learn:   { icon: BookOpen,   label: "Learn",   accent: "280 70% 60%" },
  life:    { icon: Sparkles,   label: "Life",    accent: "292 78% 63%" },
};

export function categoryFor(category: CardCategory): CategoryMeta {
  return CATEGORY_META[category] ?? CATEGORY_META.life;
}
