/**
 * 卡片来源 slug → RN 图标——web ui-web/card/source-app-display 的对应物。
 * 解析走 @pin-ai/core 的 sourceAppMeta（跨端纯元数据）：brand 品牌词命中品牌
 * （web 用品牌 SVG，RN 没有 → 用最接近的 lucide 同义图标，同 toolkit-icons 的约定）；
 * iconKey 内部语义键（web/memory/device/profile/goal/preference）走 mono lucide
 * （web 这些本就是 mono 图标，逐字对齐）。
 */
import {
  Brain,
  Calendar,
  FileText,
  FolderOpen,
  Globe,
  Mail,
  MessageSquare,
  SlidersHorizontal,
  SquareKanban,
  Smartphone,
  Table2,
  Target,
  User,
  type LucideIcon,
} from "lucide-react-native";
import { sourceAppMeta, type SourceBrand, type SourceIconKey } from "@pin-ai/core";

const BRAND_ICONS: Record<SourceBrand, LucideIcon> = {
  gmail: Mail,
  gcal: Calendar,
  gdrive: FolderOpen,
  gdocs: FileText,
  gsheets: Table2,
  slack: MessageSquare,
  notion: FileText,
  linear: SquareKanban,
};

const KEY_ICONS: Record<SourceIconKey, LucideIcon> = {
  web: Globe,
  memory: Brain,
  device: Smartphone,
  profile: User,
  goal: Target,
  preference: SlidersHorizontal,
};

/** slug → 来源图标（brand 优先，再 iconKey，未知回落 Globe）。 */
export function sourceIcon(slug: string): LucideIcon {
  const meta = sourceAppMeta(slug);
  if (meta.brand) return BRAND_ICONS[meta.brand];
  if (meta.iconKey) return KEY_ICONS[meta.iconKey];
  return Globe;
}

/** slug → 来源展示名（英文，web 同源；i18n 后续刀再接）。 */
export function sourceLabel(slug: string): string {
  return sourceAppMeta(slug).label;
}
