/**
 * Goal basket(目标类目)→ 展示元数据。平台无关的纯数据 + 归一化逻辑。
 *
 * 图标是平台介质(web=lucide-react、RN=lucide-react-native),不能进 core。
 * 所以这里只产出语义 `iconKey`,由各端把 iconKey 映射成自己的图标组件
 * (web: packages/ui-web/src/card/basket-meta.ts;RN: apps/mobile 同名绑定)。
 */

/** 归一化后的类目语义键。各端据此绑定图标,label 直接用。 */
export type BasketIconKey =
  | "work"
  | "health"
  | "family"
  | "finance"
  | "growth"
  | "life"
  | "general";

export interface BasketCategory {
  iconKey: BasketIconKey;
  label: string;
}

/** 输入 key(含同义词)→ 规范类目。多个输入收敛到同一 iconKey + label。 */
const BASKET_CATEGORIES: Record<string, BasketCategory> = {
  work: { iconKey: "work", label: "Work" },
  career: { iconKey: "work", label: "Work" },
  health: { iconKey: "health", label: "Health" },
  stay: { iconKey: "health", label: "Health" },
  family: { iconKey: "family", label: "Family" },
  relationships: { iconKey: "family", label: "Family" },
  wealth: { iconKey: "finance", label: "Finance" },
  finance: { iconKey: "finance", label: "Finance" },
  financial: { iconKey: "finance", label: "Finance" },
  growth: { iconKey: "growth", label: "Growth" },
  learn: { iconKey: "growth", label: "Growth" },
  life: { iconKey: "life", label: "Life" },
};

const FALLBACK: BasketCategory = { iconKey: "general", label: "General" };

/** key → 规范类目:精确命中 → 取连字符前缀再试 → fallback。 */
export function basketCategory(key: string): BasketCategory {
  const k = key?.toLowerCase();
  return BASKET_CATEGORIES[k] ?? BASKET_CATEGORIES[k?.split("-")[0]] ?? FALLBACK;
}
