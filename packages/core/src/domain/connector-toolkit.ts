/**
 * Connector(Composio toolkit)注册表:任意 slug(prompt 写的下划线友好形 /
 * 后端 connections.toolkit 的无下划线形)→ canonical slug + 展示 label + 语义图标键。
 * 平台无关纯数据;图标组件绑定交各端(web: ui-web/connect/toolkit-icons)。
 *
 * 与 pinai-agents generator.py / main_chat.py 的 slug 白名单、DataConnections 的
 * INPUT_CATEGORIES composioId 保持同步。
 */

export type ToolkitIconKey =
  | "mail"
  | "calendar"
  | "message-square"
  | "code"
  | "folder-open"
  | "file-text"
  | "table"
  | "users"
  | "credit-card"
  | "video";

export interface ToolkitInfo {
  /** Slug accepted by `useComposio().connectToolkit(...)`. */
  canonicalSlug: string;
  /** Short human label used after "Connect ": "Calendar", "Drive", "Gmail". */
  label: string;
  iconKey: ToolkitIconKey;
}

// Canonical Composio slug → metadata. Composio uses the no-underscore form
// (e.g. "googlecalendar"); the alias table normalizes the prompt-friendly
// underscore form.
const CANONICAL: Record<string, ToolkitInfo> = {
  gmail: { canonicalSlug: "gmail", label: "Gmail", iconKey: "mail" },
  googlecalendar: { canonicalSlug: "googlecalendar", label: "Calendar", iconKey: "calendar" },
  slack: { canonicalSlug: "slack", label: "Slack", iconKey: "message-square" },
  github: { canonicalSlug: "github", label: "GitHub", iconKey: "code" },
  googlesuper: { canonicalSlug: "googlesuper", label: "Google Workspace", iconKey: "folder-open" },
  googledrive: { canonicalSlug: "googledrive", label: "Drive", iconKey: "folder-open" },
  googledocs: { canonicalSlug: "googledocs", label: "Docs", iconKey: "file-text" },
  googlesheets: { canonicalSlug: "googlesheets", label: "Sheets", iconKey: "table" },
  calendly: { canonicalSlug: "calendly", label: "Calendly", iconKey: "calendar" },
  linkedin: { canonicalSlug: "linkedin", label: "LinkedIn", iconKey: "users" },
  stripe: { canonicalSlug: "stripe", label: "Stripe", iconKey: "credit-card" },
  youtube: { canonicalSlug: "youtube", label: "YouTube", iconKey: "video" },
};

// Accept prompt-friendly aliases. The LLM tends to write the more readable
// underscore form; map it to the Composio slug.
const ALIASES: Record<string, string> = {
  google_calendar: "googlecalendar",
  gcal: "googlecalendar",
  google_drive: "googledrive",
  gdrive: "googledrive",
  google_docs: "googledocs",
  gdocs: "googledocs",
  google_sheets: "googlesheets",
  gsheets: "googlesheets",
  google_workspace: "googlesuper",
  google: "googlesuper",
  workspace: "googlesuper",
};

/**
 * Look up a toolkit by any accepted slug form. Returns null for unknown slugs
 * so callers can degrade safely (e.g. ConnectChip falls back to literal text).
 */
export function resolveToolkit(slug: string): ToolkitInfo | null {
  if (!slug) return null;
  const lower = slug.toLowerCase().trim();
  const resolved = ALIASES[lower] ?? lower;
  return CANONICAL[resolved] ?? null;
}
