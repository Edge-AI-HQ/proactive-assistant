/**
 * Composio `userInfo` → short label for UI (Data connections, etc.).
 * Keep in sync with `proactive-ai/src/core/domains/personal/provider.ts` `extractIdentity`.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const OAUTH_OR_MACHINE_KEY =
  /^(iss|issuer|aud|azp|jti|nonce|iat|exp|nbf|at_hash|c_hash|acr|amr|sid|kid|typ|alg|scope|session|flow_state|provider_id|ref)$/i;

const LEGACY_SKIP_KEYS =
  /token|secret|key|password|code|cursor|etag|sync|url|endpoint|slug|status|type|version|id$/i;

const TOOLKIT_LABELS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  slack: "Slack",
  github: "GitHub",
  linkedin: "LinkedIn",
  notion: "Notion",
  zoom: "Zoom",
};

export interface ComposioIdentityConnection {
  toolkit: string;
  status?: string;
  connectedAccountId?: string | null;
  /** Authoritative label from backend (pai_connector_labels). When
   *  present, callers should display it directly without running the
   *  heuristics below. */
  label?: string | null;
  userInfo?: Record<string, unknown> | null;
}

function isIdentityNoiseValue(value: string): boolean {
  const t = value.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
  if (/\bsupabase\.co\b/.test(lower)) return true;
  if (/\/auth\/v1\b/.test(t)) return true;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(t)) return true;
  return false;
}

function identityKeySkippable(k: string): boolean {
  return OAUTH_OR_MACHINE_KEY.test(k) || LEGACY_SKIP_KEYS.test(k);
}

function getStringFieldCI(
  info: Record<string, unknown>,
  ...candidates: string[]
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, "");
  const map = new Map<string, string>();
  for (const key of Object.keys(info)) map.set(norm(key), key);
  for (const want of candidates) {
    const orig = map.get(norm(want));
    if (!orig) continue;
    const v = info[orig];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || isIdentityNoiseValue(t)) continue;
    if (t.length > 120) continue;
    return t;
  }
  return null;
}

export function extractComposioDisplayIdentity(
  info: Record<string, unknown> | null | undefined,
): string | null {
  if (!info) return null;

  const preferred = getStringFieldCI(
    info,
    "email",
    "emailAddress",
    "email_address",
    "mail",
    "primaryEmailAddress",
    "primary_email",
    "accountEmail",
    "account_email",
    "userEmail",
    "user_email",
    "userPrincipalName",
    "user_principal_name",
    "displayName",
    "display_name",
    "name",
    "full_name",
    "given_name",
    "username",
    "login",
    "preferred_username",
    "nickname",
  );
  if (preferred) {
    if (EMAIL_RE.test(preferred)) return preferred;
    if (!isIdentityNoiseValue(preferred)) return preferred;
  }

  for (const v of Object.values(info)) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!EMAIL_RE.test(t) || isIdentityNoiseValue(t)) continue;
    return t;
  }

  for (const [k, v] of Object.entries(info)) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t.length > 60) continue;
    if (isIdentityNoiseValue(t)) continue;
    if (identityKeySkippable(k)) continue;
    return t;
  }

  return null;
}

export function formatComposioToolkitName(toolkit: string): string {
  const normalized = toolkit.trim().toLowerCase();
  if (!normalized) return "Connector";
  const label = TOOLKIT_LABELS[normalized];
  if (label) return label;
  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveComposioConnectionIdentity(
  conn: ComposioIdentityConnection,
  _allConnections: ComposioIdentityConnection[],
): string | null {
  // Backend-resolved label is authoritative. Populated for every
  // connection post-migration 040 (eager resolve at /wait time, lazy
  // retry on /connections). The `userInfo` heuristic stays as a fallback
  // for the brief deployment window where new frontend talks to old
  // backend, and for transient cases where the label hasn't been
  // persisted yet (legacy pre-040 connections without a row).
  if (conn.label) return conn.label;
  return extractComposioDisplayIdentity(conn.userInfo);
}

export function formatComposioConnectionIdentity(
  conn: ComposioIdentityConnection,
  allConnections: ComposioIdentityConnection[],
): string {
  return resolveComposioConnectionIdentity(conn, allConnections) ?? "Account details unavailable";
}

export function formatOptionalComposioConnectionIdentity(
  conn: ComposioIdentityConnection,
  allConnections: ComposioIdentityConnection[],
): string | null {
  return resolveComposioConnectionIdentity(conn, allConnections);
}
