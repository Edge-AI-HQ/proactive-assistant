/**
 * Connector toolkit 的 RN 图标绑定——web packages/ui-web/src/connect/toolkit-icons.ts
 * 的对应物。解析逻辑（任意 slug → canonical + iconKey）共享 @pin-ai/core 的
 * resolveToolkit；这里只把同一组语义 iconKey 绑成 lucide-react-native 同名图标
 * （与 web TOOLKIT_ICONS 逐一对应，保证两端同一连接器同一图标）。
 */
import {
  Calendar,
  Code,
  CreditCard,
  FileText,
  FolderOpen,
  Mail,
  MessageSquare,
  Table2,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react-native";
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

/** slug → lucide-react-native 图标；未知 slug 返回 null，调用方按 web 顺序降级。 */
export function getToolkitIcon(slug: string): LucideIcon | null {
  const info = resolveToolkit(slug);
  return info ? TOOLKIT_ICONS[info.iconKey] : null;
}
