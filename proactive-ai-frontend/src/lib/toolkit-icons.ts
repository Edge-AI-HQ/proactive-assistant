/**
 * Single source of truth for connector-guidance UI: maps any toolkit slug
 * the prompt may emit (LLM writes `[connect:google_calendar]` while the
 * backend `connections.toolkit` field stores `googlecalendar`) to a
 * canonical Composio slug that `useComposio().connectToolkit(...)` accepts,
 * plus the display label and icon used by `ConnectChip` and the connector
 * card icon strip.
 *
 * Keep this in sync with the prompt slug whitelist in
 * `pinai-agents/src/pinai_agents/chat/agents/generator.py` and `main_chat.py`,
 * and with the `composioId` values in `DataConnections.tsx`'s INPUT_CATEGORIES.
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

export interface ToolkitMeta {
  /** Slug accepted by `useComposio().connectToolkit(...)`. */
  canonicalSlug: string;
  /** Short human label used after "Connect ": "Calendar", "Drive", "Gmail". */
  label: string;
  icon: LucideIcon;
}

// Canonical Composio slug → metadata. Composio uses the no-underscore
// form (e.g. "googlecalendar"); the alias table below normalizes the
// prompt-friendly underscore form.
const CANONICAL: Record<string, ToolkitMeta> = {
  gmail: { canonicalSlug: "gmail", label: "Gmail", icon: Mail },
  googlecalendar: { canonicalSlug: "googlecalendar", label: "Calendar", icon: Calendar },
  slack: { canonicalSlug: "slack", label: "Slack", icon: MessageSquare },
  github: { canonicalSlug: "github", label: "GitHub", icon: Code },
  googlesuper: { canonicalSlug: "googlesuper", label: "Google Workspace", icon: FolderOpen },
  googledrive: { canonicalSlug: "googledrive", label: "Drive", icon: FolderOpen },
  googledocs: { canonicalSlug: "googledocs", label: "Docs", icon: FileText },
  googlesheets: { canonicalSlug: "googlesheets", label: "Sheets", icon: Table2 },
  calendly: { canonicalSlug: "calendly", label: "Calendly", icon: Calendar },
  linkedin: { canonicalSlug: "linkedin", label: "LinkedIn", icon: Users },
  stripe: { canonicalSlug: "stripe", label: "Stripe", icon: CreditCard },
  youtube: { canonicalSlug: "youtube", label: "YouTube", icon: Video },
};

// Accept prompt-friendly aliases. The LLM tends to write the more
// readable underscore form; map it to the Composio slug.
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
 * Look up a toolkit by any accepted slug form. Returns null for unknown
 * slugs so callers can degrade safely (e.g. ConnectChip falls back to
 * literal text rather than rendering a broken button).
 */
export function getToolkit(slug: string): ToolkitMeta | null {
  if (!slug) return null;
  const lower = slug.toLowerCase().trim();
  const resolved = ALIASES[lower] ?? lower;
  return CANONICAL[resolved] ?? null;
}
