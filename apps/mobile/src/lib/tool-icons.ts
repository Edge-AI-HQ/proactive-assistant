/**
 * 执行计划步骤的工具图标——web ui-web/card/chat-card-presentation 的 detectToolIcon
 * 的 RN 对应物。正则判别逐字照搬；brand 命中用最接近的 lucide（web 用品牌 SVG，
 * RN 无 → 同 source-icons/toolkit-icons 约定），mono 命中用 web 同款 lucide
 * （lucide-react-native 同名图标）。
 */
import {
  Bell,
  Brain,
  Calendar,
  Database,
  DollarSign,
  FileSearch,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  Mail,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  SquareKanban,
  Table2,
  Users,
  type LucideIcon,
} from "lucide-react-native";

/** 工具文本（step.text + " " + step.tool）→ lucide-react-native 图标。 */
export function toolIcon(text: string): LucideIcon {
  const t = text.toLowerCase();
  if (/(gmail|email|sending email|searching emails|inbox|reply)/.test(t)) return Mail;
  if (/(calendar|appointment|schedule|meeting|reminder)/.test(t)) return Calendar;
  if (/(slack|channel|message)/.test(t)) return MessageSquare;
  if (/(notion)/.test(t)) return FileText;
  if (/(linear|issue|ticket)/.test(t)) return SquareKanban;
  if (/(drive|upload|download|file)/.test(t)) return FolderOpen;
  if (/(doc|draft|document)/.test(t)) return FileText;
  if (/(sheet|spreadsheet|table)/.test(t)) return Table2;
  if (/(web|search.*web|browse|website|http)/.test(t)) return Globe;
  if (/(memor|recall|history)/.test(t)) return FileSearch;
  if (/(approv|waiting|requesting)/.test(t)) return Hand;
  if (/(payment|invoice|cost|budget)/.test(t)) return DollarSign;
  if (/(team|people|contact)/.test(t)) return Users;
  if (/(notif|alert|flag)/.test(t)) return Bell;
  if (/(query|database|sql)/.test(t)) return Database;
  if (/(plan|re-plan|finalizing|preparing|drafting|incorporating|context|setting|configur)/.test(t)) return Settings;
  if (/(search|find|look|cross-check|validating)/.test(t)) return Search;
  if (/(think|reason|analy)/.test(t)) return Brain;
  return Sparkles;
}
