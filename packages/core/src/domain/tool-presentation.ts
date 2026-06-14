/**
 * Tool name → (iconKey, human verb) 映射。平台无关纯数据。
 *
 * 两层:
 *   - 精确名查内部 sandbox 工具(lowercase_underscore,如 `exec`、`web_search`)
 *   - 前缀正则兜底 Composio 工具(UPPERCASE_UNDERSCORE,如 `GMAIL_FETCH_EMAILS`)
 *
 * 未知工具回退 wrench + title-case 名,聊天线程仍能渲染。`iconKey` 由各端绑定图标
 * (web: ui-web/chat/conversation/tool-presentation)。
 */

export type ToolIconKey =
  | "terminal"
  | "globe"
  | "search"
  | "download"
  | "file-text"
  | "pen-line"
  | "scissors"
  | "file-edit"
  | "message-square"
  | "image"
  | "paintbrush"
  | "music"
  | "video"
  | "volume2"
  | "clock"
  | "database"
  | "list"
  | "send"
  | "user-cog"
  | "bot"
  | "wrench"
  | "mail"
  | "calendar";

export interface ToolPresentationMeta {
  iconKey: ToolIconKey;
  verb: string;
}

const NAME_MAP: Record<string, ToolPresentationMeta> = {
  exec: { iconKey: "terminal", verb: "Ran" },
  execute: { iconKey: "terminal", verb: "Ran command" },
  process: { iconKey: "terminal", verb: "Ran" },
  code_execution: { iconKey: "terminal", verb: "Executed" },
  python_exec: { iconKey: "terminal", verb: "Ran Python" },
  browser: { iconKey: "globe", verb: "Browsed" },
  browser_tool: { iconKey: "globe", verb: "Browsed" },
  web_search: { iconKey: "search", verb: "Searched web" },
  tavily_search: { iconKey: "search", verb: "Searched web" },
  tavily_extract: { iconKey: "download", verb: "Read pages" },
  world_search: { iconKey: "search", verb: "Searched news" },
  memory_search: { iconKey: "database", verb: "Searched memory" },
  x_search: { iconKey: "search", verb: "Searched X" },
  web_fetch: { iconKey: "download", verb: "Fetched" },
  read: { iconKey: "file-text", verb: "Read" },
  write: { iconKey: "pen-line", verb: "Wrote" },
  edit: { iconKey: "scissors", verb: "Edited" },
  apply_patch: { iconKey: "file-edit", verb: "Patched" },
  message: { iconKey: "message-square", verb: "Messaged" },
  image: { iconKey: "image", verb: "Read image" },
  image_generate: { iconKey: "paintbrush", verb: "Generated image" },
  video_generate: { iconKey: "video", verb: "Generated video" },
  music_generate: { iconKey: "music", verb: "Generated music" },
  tts: { iconKey: "volume2", verb: "Spoke" },
  canvas: { iconKey: "paintbrush", verb: "Drew" },
  cron: { iconKey: "clock", verb: "Scheduled" },
  session_status: { iconKey: "database", verb: "Checked session" },
  sessions_list: { iconKey: "list", verb: "Listed sessions" },
  sessions_history: { iconKey: "list", verb: "Loaded history" },
  sessions_send: { iconKey: "send", verb: "Sent" },
  sessions_spawn: { iconKey: "user-cog", verb: "Spawned agent" },
  subagents: { iconKey: "bot", verb: "Delegated to agent" },
  task: { iconKey: "bot", verb: "Delegated" },
  write_todos: { iconKey: "list", verb: "Updated plan" },
  notify_user: { iconKey: "message-square", verb: "Messaged you" },
};

// Composio 工具前缀兜底。顺序敏感:更具体的 pattern 在前。
const PREFIX_MAP: Array<[RegExp, ToolPresentationMeta]> = [
  [/^GMAIL_FETCH/i, { iconKey: "mail", verb: "Searched Gmail" }],
  [/^GMAIL_(SEND|CREATE|REPLY)/i, { iconKey: "mail", verb: "Drafted email" }],
  [/^GMAIL_/i, { iconKey: "mail", verb: "Used Gmail" }],
  [/^GCAL_(FETCH|FIND|LIST|GET)/i, { iconKey: "calendar", verb: "Read calendar" }],
  [/^GCAL_(CREATE|UPDATE|DELETE)/i, { iconKey: "calendar", verb: "Updated calendar" }],
  [/^GCAL_/i, { iconKey: "calendar", verb: "Used calendar" }],
  [/^NOTION_/i, { iconKey: "file-text", verb: "Searched Notion" }],
  [/^SLACK_(SEND|POST)/i, { iconKey: "message-square", verb: "Sent on Slack" }],
  [/^SLACK_/i, { iconKey: "message-square", verb: "Searched Slack" }],
  [/^GOOGLEDRIVE_/i, { iconKey: "file-text", verb: "Searched Drive" }],
];

export function resolveToolPresentationMeta(toolName: string): ToolPresentationMeta {
  if (NAME_MAP[toolName]) return NAME_MAP[toolName];
  for (const [re, meta] of PREFIX_MAP) {
    if (re.test(toolName)) return meta;
  }
  return {
    iconKey: "wrench",
    verb: toolName.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  };
}
