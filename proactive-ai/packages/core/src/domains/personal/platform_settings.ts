import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface PersonalPlatformSettings {
  apiKey?: string;
  apiBase?: string;
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
  resolve(homeDir, ".openclaw-proactive-ai", "local-settings.json");

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
      userId: asString(composio.userId),
      callbackUrl: asString(composio.callbackUrl),
      authConfigMap: Object.keys(authConfigMap).length > 0 ? authConfigMap : undefined,
    };
  } catch {
    return {};
  }
};
