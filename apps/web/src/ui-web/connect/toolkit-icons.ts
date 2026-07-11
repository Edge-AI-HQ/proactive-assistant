/**
 * Connector toolkit 的 web 图标绑定。注册表 + 别名 + 解析逻辑已下沉
 * @pin-ai/core(domain/connector-toolkit);这里只把语义 iconKey 绑成 lucide,
 * 产出消费方(ConnectChip / connector-card / ZebraTasksSplit / CardTimeline)要的
 * ToolkitMeta(含 icon)。RN 用 lucide-react-native 自绑同一组 iconKey。
 */
import {
  Mail,
  Calendar,
  MessageSquare,
  Code,
  Users,
  Video,
  CreditCard,
  FolderOpen,
  FileText,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { resolveToolkit, type ToolkitIconKey } from "@pin-ai/core";

const TOOLKIT_ICONS: Record<ToolkitIconKey, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  "message-square": MessageSquare,
  code: Code,
  "folder-open": FolderOpen,
  "file-text": FileText,
  table: Table2,
  users: Users,
  "credit-card": CreditCard,
  video: Video,
};

export interface ToolkitMeta {
  /** Slug accepted by `useComposio().connectToolkit(...)`. */
  canonicalSlug: string;
  /** Short human label used after "Connect ": "Calendar", "Drive", "Gmail". */
  label: string;
  icon: LucideIcon;
}

/**
 * Look up a toolkit by any accepted slug form. Returns null for unknown slugs
 * so callers can degrade safely (e.g. ConnectChip falls back to literal text).
 */
export function getToolkit(slug: string): ToolkitMeta | null {
  const info = resolveToolkit(slug);
  if (!info) return null;
  return { canonicalSlug: info.canonicalSlug, label: info.label, icon: TOOLKIT_ICONS[info.iconKey] };
}
