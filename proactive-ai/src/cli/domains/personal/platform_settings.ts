import { existsSync, readFileSync } from "node:fs";
import { resolveAppRoot, appPaths } from "../../../core/paths.js";

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

export const loadPlatformSettings = (homeDir: string): PersonalPlatformSettings => {
  const path = appPaths.localSettings(resolveAppRoot(undefined, homeDir));
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
