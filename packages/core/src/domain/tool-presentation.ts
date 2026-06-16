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

/**
 * 语义文案键。各端绑 i18n(web: chat.json `toolVerbs.*`)。与 `verb`(英文回落)
 * 并存:迁移完成的消费者用 `verbKey`,未迁移的(含 unknown-tool 兜底)仍读 `verb`。
 */
export type ToolVerbKey =
  | "ran"
  | "ranCommand"
  | "executed"
  | "ranPython"
  | "browsed"
  | "searchedWeb"
  | "readPages"
  | "searchedNews"
  | "searchedMemory"
  | "searchedX"
  | "fetched"
  | "read"
  | "wrote"
  | "edited"
  | "patched"
  | "messaged"
  | "readImage"
  | "generatedImage"
  | "generatedVideo"
  | "generatedMusic"
  | "spoke"
  | "drew"
  | "scheduled"
  | "checkedSession"
  | "listedSessions"
  | "loadedHistory"
  | "sent"
  | "spawnedAgent"
  | "delegatedToAgent"
  | "delegated"
  | "updatedPlan"
  | "messagedYou"
  | "searchedGmail"
  | "draftedEmail"
  | "usedGmail"
  | "readCalendar"
  | "updatedCalendar"
  | "usedCalendar"
  | "searchedNotion"
  | "sentOnSlack"
  | "searchedSlack"
  | "searchedDrive";

export interface ToolPresentationMeta {
  iconKey: ToolIconKey;
  verb: string;
  /** i18n 键(chat.json toolVerbs.*)。unknown-tool 兜底不给,回落英文 `verb`。 */
  verbKey?: ToolVerbKey;
}

const NAME_MAP: Record<string, ToolPresentationMeta> = {
  exec: { iconKey: "terminal", verb: "Ran", verbKey: "ran" },
  execute: { iconKey: "terminal", verb: "Ran command", verbKey: "ranCommand" },
  process: { iconKey: "terminal", verb: "Ran", verbKey: "ran" },
  code_execution: { iconKey: "terminal", verb: "Executed", verbKey: "executed" },
  python_exec: { iconKey: "terminal", verb: "Ran Python", verbKey: "ranPython" },
  browser: { iconKey: "globe", verb: "Browsed", verbKey: "browsed" },
  browser_tool: { iconKey: "globe", verb: "Browsed", verbKey: "browsed" },
  web_search: { iconKey: "search", verb: "Searched web", verbKey: "searchedWeb" },
  tavily_search: { iconKey: "search", verb: "Searched web", verbKey: "searchedWeb" },
  tavily_extract: { iconKey: "download", verb: "Read pages", verbKey: "readPages" },
  world_search: { iconKey: "search", verb: "Searched news", verbKey: "searchedNews" },
  memory_search: { iconKey: "database", verb: "Searched memory", verbKey: "searchedMemory" },
  x_search: { iconKey: "search", verb: "Searched X", verbKey: "searchedX" },
  web_fetch: { iconKey: "download", verb: "Fetched", verbKey: "fetched" },
  read: { iconKey: "file-text", verb: "Read", verbKey: "read" },
  write: { iconKey: "pen-line", verb: "Wrote", verbKey: "wrote" },
  edit: { iconKey: "scissors", verb: "Edited", verbKey: "edited" },
  apply_patch: { iconKey: "file-edit", verb: "Patched", verbKey: "patched" },
  message: { iconKey: "message-square", verb: "Messaged", verbKey: "messaged" },
  image: { iconKey: "image", verb: "Read image", verbKey: "readImage" },
  image_generate: { iconKey: "paintbrush", verb: "Generated image", verbKey: "generatedImage" },
  video_generate: { iconKey: "video", verb: "Generated video", verbKey: "generatedVideo" },
  music_generate: { iconKey: "music", verb: "Generated music", verbKey: "generatedMusic" },
  tts: { iconKey: "volume2", verb: "Spoke", verbKey: "spoke" },
  canvas: { iconKey: "paintbrush", verb: "Drew", verbKey: "drew" },
  cron: { iconKey: "clock", verb: "Scheduled", verbKey: "scheduled" },
  session_status: { iconKey: "database", verb: "Checked session", verbKey: "checkedSession" },
  sessions_list: { iconKey: "list", verb: "Listed sessions", verbKey: "listedSessions" },
  sessions_history: { iconKey: "list", verb: "Loaded history", verbKey: "loadedHistory" },
  sessions_send: { iconKey: "send", verb: "Sent", verbKey: "sent" },
  sessions_spawn: { iconKey: "user-cog", verb: "Spawned agent", verbKey: "spawnedAgent" },
  subagents: { iconKey: "bot", verb: "Delegated to agent", verbKey: "delegatedToAgent" },
  task: { iconKey: "bot", verb: "Delegated", verbKey: "delegated" },
  write_todos: { iconKey: "list", verb: "Updated plan", verbKey: "updatedPlan" },
  notify_user: { iconKey: "message-square", verb: "Messaged you", verbKey: "messagedYou" },
};

// Composio 工具前缀兜底。顺序敏感:更具体的 pattern 在前。
const PREFIX_MAP: Array<[RegExp, ToolPresentationMeta]> = [
  [/^GMAIL_FETCH/i, { iconKey: "mail", verb: "Searched Gmail", verbKey: "searchedGmail" }],
  [/^GMAIL_(SEND|CREATE|REPLY)/i, { iconKey: "mail", verb: "Drafted email", verbKey: "draftedEmail" }],
  [/^GMAIL_/i, { iconKey: "mail", verb: "Used Gmail", verbKey: "usedGmail" }],
  [/^GCAL_(FETCH|FIND|LIST|GET)/i, { iconKey: "calendar", verb: "Read calendar", verbKey: "readCalendar" }],
  [/^GCAL_(CREATE|UPDATE|DELETE)/i, { iconKey: "calendar", verb: "Updated calendar", verbKey: "updatedCalendar" }],
  [/^GCAL_/i, { iconKey: "calendar", verb: "Used calendar", verbKey: "usedCalendar" }],
  [/^NOTION_/i, { iconKey: "file-text", verb: "Searched Notion", verbKey: "searchedNotion" }],
  [/^SLACK_(SEND|POST)/i, { iconKey: "message-square", verb: "Sent on Slack", verbKey: "sentOnSlack" }],
  [/^SLACK_/i, { iconKey: "message-square", verb: "Searched Slack", verbKey: "searchedSlack" }],
  [/^GOOGLEDRIVE_/i, { iconKey: "file-text", verb: "Searched Drive", verbKey: "searchedDrive" }],
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
