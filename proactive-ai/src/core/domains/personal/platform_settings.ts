import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAppRoot, appPaths } from "../../paths.js";

export interface AccountIdentity {
  toolkit: string;
  userInfo: Record<string, unknown>;
}

export interface PersonalPlatformSettings {
  apiKey?: string;
  apiBase?: string;
  userId?: string;
  callbackUrl?: string;
  authConfigMap?: Record<string, string>;
  /** Cached identity per connected account: connectedAccountId → identity data. */
  accountIdentities?: Record<string, AccountIdentity>;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const settingsPath = (
  homeDir: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
) => appPaths.localSettings(resolveAppRoot(env, homeDir));

// ── In-memory settings cache ──
// Eliminates redundant disk reads across multiple calls per page load.
// Write helpers update both disk and cache atomically.

let _cachedPath: string | null = null;
let _cachedRaw: Record<string, unknown> | null = null;
let _cachedParsed: PersonalPlatformSettings | null = null;

/** Invalidate cached settings (for testing). */
export const _resetSettingsCache = (): void => {
  _cachedPath = null;
  _cachedRaw = null;
  _cachedParsed = null;
};

/** Read raw JSON from disk (or return cached). */
function readRawSettings(path: string): Record<string, unknown> {
  if (_cachedPath === path && _cachedRaw) return _cachedRaw;
  if (!existsSync(path)) {
    _cachedPath = path;
    _cachedRaw = {};
    _cachedParsed = null;
    return {};
  }
  try {
    const raw = asObject(JSON.parse(readFileSync(path, "utf-8")));
    _cachedPath = path;
    _cachedRaw = raw;
    _cachedParsed = null; // invalidate parsed
    return raw;
  } catch {
    _cachedPath = path;
    _cachedRaw = {};
    _cachedParsed = null;
    return {};
  }
}

/** Write raw JSON to disk and update cache. */
function writeRawSettings(path: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2), { encoding: "utf-8", mode: 0o600 });
  _cachedPath = path;
  _cachedRaw = raw;
  _cachedParsed = null; // invalidate parsed
}

/**
 * Save a Composio API key to local-settings.json.
 * Merges with existing settings — only touches `composio.apiKey`.
 */
export const savePlatformApiKey = (
  homeDir: string,
  apiKey: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void => {
  const path = settingsPath(homeDir, env);
  const existing = { ...readRawSettings(path) };
  existing.composio = { ...asObject(existing.composio), apiKey };
  writeRawSettings(path, existing);
};

/** Merge-save a single account identity into local-settings.json. */
export const saveAccountIdentity = (
  homeDir: string,
  connectedAccountId: string,
  identity: AccountIdentity,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void => {
  const path = settingsPath(homeDir, env);
  const existing = { ...readRawSettings(path) };
  const composio = asObject(existing.composio);
  const identities = { ...asObject(composio.accountIdentities), [connectedAccountId]: identity };
  existing.composio = { ...composio, accountIdentities: identities };
  writeRawSettings(path, existing);
};

/** Remove a single account identity from local-settings.json. */
export const deleteAccountIdentity = (
  homeDir: string,
  connectedAccountId: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void => {
  const path = settingsPath(homeDir, env);
  const existing = { ...readRawSettings(path) };
  const composio = asObject(existing.composio);
  const identities = { ...asObject(composio.accountIdentities) };
  delete identities[connectedAccountId];
  existing.composio = { ...composio, accountIdentities: identities };
  writeRawSettings(path, existing);
};

/** Remove identity entries not in the given set of active account IDs. */
export const pruneOrphanIdentities = (
  homeDir: string,
  activeAccountIds: Set<string>,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void => {
  const path = settingsPath(homeDir, env);
  const existing = { ...readRawSettings(path) };
  const composio = asObject(existing.composio);
  const identities = asObject(composio.accountIdentities);
  const keys = Object.keys(identities);
  const orphans = keys.filter((id) => !activeAccountIds.has(id));
  if (orphans.length === 0) return;
  const cleaned = { ...identities };
  for (const id of orphans) delete cleaned[id];
  existing.composio = { ...composio, accountIdentities: cleaned };
  writeRawSettings(path, existing);
};

function parseComposioSettings(composio: Record<string, unknown>): PersonalPlatformSettings {
  const rawMap = asObject(composio.authConfigMap);
  const authConfigMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawMap)) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = asString(value);
    if (normalizedKey && normalizedValue) {
      authConfigMap[normalizedKey] = normalizedValue;
    }
  }

  const rawIdentities = asObject(composio.accountIdentities);
  const accountIdentities: Record<string, AccountIdentity> = {};
  for (const [accountId, entry] of Object.entries(rawIdentities)) {
    const row = asObject(entry);
    const toolkit = asString(row.toolkit);
    const userInfo = asObject(row.userInfo);
    if (toolkit && Object.keys(userInfo).length > 0) {
      accountIdentities[accountId] = { toolkit, userInfo };
    }
  }

  return {
    apiKey: asString(composio.apiKey),
    apiBase: asString(composio.apiBase),
    userId: asString(composio.userId),
    callbackUrl: asString(composio.callbackUrl),
    authConfigMap: Object.keys(authConfigMap).length > 0 ? authConfigMap : undefined,
    accountIdentities: Object.keys(accountIdentities).length > 0 ? accountIdentities : undefined,
  };
}

export const loadPlatformSettings = (
  homeDir: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): PersonalPlatformSettings => {
  const path = settingsPath(homeDir, env);
  const raw = readRawSettings(path);
  if (_cachedParsed && _cachedPath === path) return _cachedParsed;
  const composio = asObject(raw.composio);
  const parsed = parseComposioSettings(composio);
  _cachedParsed = parsed;
  return parsed;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Load or create a stable Composio user ID.
 *
 * Resolution order:
 *   1. `local-settings.json` → `composio.userId`  (canonical)
 *   2. Legacy `composio-user-id` file              (migrated → settings)
 *   3. Generate new UUID and persist to settings
 *
 * Both server (core) and CLI share this function so they always
 * resolve to the same identity — connections created in the UI are
 * visible from the CLI and vice-versa.
 */
export const loadOrCreateUserId = (
  homeDir: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string => {
  const root = resolveAppRoot(env, homeDir);
  const path = appPaths.localSettings(root);

  // 1. Already in local-settings.json?
  const settings = loadPlatformSettings(homeDir, env);
  if (settings.userId && UUID_RE.test(settings.userId)) {
    return settings.userId;
  }

  // 2. Legacy composio-user-id file?
  const legacyPath = appPaths.composioUserId(root);
  let userId: string | null = null;
  try {
    const raw = readFileSync(legacyPath, "utf-8").trim();
    if (UUID_RE.test(raw)) userId = raw;
  } catch { /* not found */ }

  // 3. Generate new UUID
  if (!userId) userId = randomUUID();

  // Persist to local-settings.json via the shared cache helpers
  // so that subsequent reads (e.g. savePlatformApiKey) see the userId.
  const existing = { ...readRawSettings(path) };
  existing.composio = { ...asObject(existing.composio), userId };
  writeRawSettings(path, existing);

  return userId;
};
