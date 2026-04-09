import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAppRoot, appPaths } from "../../paths.js";

export interface PersonalPlatformSettings {
  apiKey?: string;
  apiBase?: string;
  mcpUrl?: string;
  userId?: string;
  callbackUrl?: string;
  authConfigMap?: Record<string, string>;
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

const settingsPath = (homeDir: string) =>
  appPaths.localSettings(resolveAppRoot(undefined, homeDir));

/**
 * Save a Composio API key to local-settings.json.
 * Merges with existing settings — only touches `composio.apiKey`.
 */
export const savePlatformApiKey = (homeDir: string, apiKey: string): void => {
  const path = settingsPath(homeDir);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = asObject(JSON.parse(readFileSync(path, "utf-8")));
    } catch { /* start fresh */ }
  }
  const composio = asObject(existing.composio);
  existing.composio = { ...composio, apiKey };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(existing, null, 2), { encoding: "utf-8", mode: 0o600 });
};

export const loadPlatformSettings = (homeDir: string): PersonalPlatformSettings => {
  const path = settingsPath(homeDir);
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const root = asObject(parsed);
    const composio = asObject(root.composio);

    const rawMap = asObject(composio.authConfigMap);
    const authConfigMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawMap)) {
      const normalizedKey = key.trim().toLowerCase();
      const normalizedValue = asString(value);
      if (normalizedKey && normalizedValue) {
        authConfigMap[normalizedKey] = normalizedValue;
      }
    }

    return {
      apiKey: asString(composio.apiKey),
      apiBase: asString(composio.apiBase),
      mcpUrl: asString(composio.mcpUrl),
      userId: asString(composio.userId),
      callbackUrl: asString(composio.callbackUrl),
      authConfigMap: Object.keys(authConfigMap).length > 0 ? authConfigMap : undefined,
    };
  } catch {
    return {};
  }
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
export const loadOrCreateUserId = (homeDir: string): string => {
  const root = resolveAppRoot(undefined, homeDir);
  const settingsFile = appPaths.localSettings(root);

  // 1. Already in local-settings.json?
  const settings = loadPlatformSettings(homeDir);
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

  // Persist to local-settings.json (the canonical location)
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      existing = asObject(JSON.parse(readFileSync(settingsFile, "utf-8")));
    } catch { /* start fresh */ }
  }
  const composio = asObject(existing.composio);
  existing.composio = { ...composio, userId };
  mkdirSync(dirname(settingsFile), { recursive: true, mode: 0o700 });
  writeFileSync(settingsFile, JSON.stringify(existing, null, 2), { encoding: "utf-8", mode: 0o600 });

  return userId;
};
