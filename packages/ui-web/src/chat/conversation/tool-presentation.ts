/**
 * Tool name → (icon, human verb) mapping shared between tool-rendering
 * components.
 *
 * Two layers:
 *   - exact-name lookup for our internal sandbox tools (lowercase_underscore,
 *     e.g. `exec`, `web_search`, `write_todos`)
 *   - prefix-based fallback for Composio tools (UPPERCASE_UNDERSCORE,
 *     e.g. `GMAIL_FETCH_EMAILS`, `GCAL_FIND_FREE_SLOTS`)
 *
 * Unknown tools fall back to a generic wrench icon + title-cased name so
 * the chat thread still renders something meaningful.
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
} from "lucide-react";

export interface ToolPresentation {
  Icon: LucideIcon;
  verb: string;
}

const NAME_MAP: Record<string, ToolPresentation> = {
  exec: { Icon: Terminal, verb: "Ran" },
  execute: { Icon: Terminal, verb: "Ran command" },
  process: { Icon: Terminal, verb: "Ran" },
  code_execution: { Icon: Terminal, verb: "Executed" },
  python_exec: { Icon: Terminal, verb: "Ran Python" },
  browser: { Icon: Globe, verb: "Browsed" },
  browser_tool: { Icon: Globe, verb: "Browsed" },
  web_search: { Icon: Search, verb: "Searched web" },
  tavily_search: { Icon: Search, verb: "Searched web" },
  tavily_extract: { Icon: Download, verb: "Read pages" },
  world_search: { Icon: Search, verb: "Searched news" },
  memory_search: { Icon: Database, verb: "Searched memory" },
  x_search: { Icon: Search, verb: "Searched X" },
  web_fetch: { Icon: Download, verb: "Fetched" },
  read: { Icon: FileText, verb: "Read" },
  write: { Icon: PenLine, verb: "Wrote" },
  edit: { Icon: Scissors, verb: "Edited" },
  apply_patch: { Icon: FileEdit, verb: "Patched" },
  message: { Icon: MessageSquare, verb: "Messaged" },
  image: { Icon: ImageIcon, verb: "Read image" },
  image_generate: { Icon: Paintbrush, verb: "Generated image" },
  video_generate: { Icon: Video, verb: "Generated video" },
  music_generate: { Icon: Music, verb: "Generated music" },
  tts: { Icon: Volume2, verb: "Spoke" },
  canvas: { Icon: Paintbrush, verb: "Drew" },
  cron: { Icon: Clock, verb: "Scheduled" },
  session_status: { Icon: Database, verb: "Checked session" },
  sessions_list: { Icon: List, verb: "Listed sessions" },
  sessions_history: { Icon: List, verb: "Loaded history" },
  sessions_send: { Icon: Send, verb: "Sent" },
  sessions_spawn: { Icon: UserCog, verb: "Spawned agent" },
  subagents: { Icon: Bot, verb: "Delegated to agent" },
  task: { Icon: Bot, verb: "Delegated" },
  write_todos: { Icon: List, verb: "Updated plan" },
  notify_user: { Icon: MessageSquare, verb: "Messaged you" },
};

// Prefix-based fallback for Composio tools. Order matters: more specific
// patterns first.
const PREFIX_MAP: Array<[RegExp, ToolPresentation]> = [
  [/^GMAIL_FETCH/i, { Icon: Mail, verb: "Searched Gmail" }],
  [/^GMAIL_(SEND|CREATE|REPLY)/i, { Icon: Mail, verb: "Drafted email" }],
  [/^GMAIL_/i, { Icon: Mail, verb: "Used Gmail" }],
  [/^GCAL_(FETCH|FIND|LIST|GET)/i, { Icon: Calendar, verb: "Read calendar" }],
  [/^GCAL_(CREATE|UPDATE|DELETE)/i, { Icon: Calendar, verb: "Updated calendar" }],
  [/^GCAL_/i, { Icon: Calendar, verb: "Used calendar" }],
  [/^NOTION_/i, { Icon: FileText, verb: "Searched Notion" }],
  [/^SLACK_(SEND|POST)/i, { Icon: MessageSquare, verb: "Sent on Slack" }],
  [/^SLACK_/i, { Icon: MessageSquare, verb: "Searched Slack" }],
  [/^GOOGLEDRIVE_/i, { Icon: FileText, verb: "Searched Drive" }],
];

export function resolveToolPresentation(toolName: string): ToolPresentation {
  if (NAME_MAP[toolName]) return NAME_MAP[toolName];
  for (const [re, presentation] of PREFIX_MAP) {
    if (re.test(toolName)) return presentation;
  }
  return {
    Icon: Wrench,
    verb: toolName
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  };
}
