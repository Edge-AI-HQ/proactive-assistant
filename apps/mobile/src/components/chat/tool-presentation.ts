/**
 * Tool name → (icon, verb) 展示——web ui-web/chat/conversation/tool-presentation
 * 的 RN 对应物。数据/匹配逻辑走 core resolveToolPresentationMeta,这里把 core
 * 语义 iconKey 绑定成 lucide-react-native 图标(与 web 同一组 iconKey)、
 * verbKey 经 i18n 渲染(与 web 同一组 chat.json toolVerbs.* 键)。
 */
import {
  Terminal,
  Globe,
  Search,
  Download,
  FileText,
  PenLine,
  Scissors,
  FileEdit,
  MessageSquare,
  Image as ImageIcon,
  Paintbrush,
  Music,
  Video,
  Volume2,
  Clock,
  Database,
  List,
  Send,
  UserCog,
  Bot,
  Wrench,
  Mail,
  Calendar,
  type LucideIcon,
} from "lucide-react-native";
import { resolveToolPresentationMeta, type ToolIconKey } from "@pin-ai/core";
import i18n from "../../i18n";

export interface ToolPresentation {
  Icon: LucideIcon;
  verb: string;
}

const TOOL_ICONS: Record<ToolIconKey, LucideIcon> = {
  terminal: Terminal,
  globe: Globe,
  search: Search,
  download: Download,
  "file-text": FileText,
  "pen-line": PenLine,
  scissors: Scissors,
  "file-edit": FileEdit,
  "message-square": MessageSquare,
  image: ImageIcon,
  paintbrush: Paintbrush,
  music: Music,
  video: Video,
  volume2: Volume2,
  clock: Clock,
  database: Database,
  list: List,
  send: Send,
  "user-cog": UserCog,
  bot: Bot,
  wrench: Wrench,
  mail: Mail,
  calendar: Calendar,
};

export function resolveToolPresentation(toolName: string): ToolPresentation {
  const { iconKey, verb, verbKey } = resolveToolPresentationMeta(toolName);
  return {
    Icon: TOOL_ICONS[iconKey],
    // 已知工具走 i18n;unknown-tool 兜底没有 verbKey,回落英文 Title-Case verb。
    verb: verbKey ? i18n.t(`chat:toolVerbs.${verbKey}`) : verb,
  };
}
