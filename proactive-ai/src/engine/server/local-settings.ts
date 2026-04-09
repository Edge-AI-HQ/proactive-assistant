import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_GENERATION_LANGUAGE,
  isSupportedGenerationLanguage,
  type SupportedGenerationLanguage,
} from '../generation-language.js';
import { resolveAppRoot, appPaths } from '../../core/paths.js';

interface LocalSettings {
  composio?: Record<string, unknown>;
  generation?: {
    language?: string;
  };
  [key: string]: unknown;
}

const LOCAL_SETTINGS_PATH = appPaths.localSettings(resolveAppRoot());

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readSettingsFile(settingsPath: string): LocalSettings {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as LocalSettings;
  } catch {
    return {};
  }
}

function writeSettingsFile(settingsPath: string, settings: LocalSettings): void {
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function getLocalSettingsPath(): string {
  return LOCAL_SETTINGS_PATH;
}

export function getGenerationLanguage(settingsPath: string = LOCAL_SETTINGS_PATH): SupportedGenerationLanguage {
  const settings = readSettingsFile(settingsPath);
  const generation = asObject(settings.generation);
  const language = generation.language;
  return isSupportedGenerationLanguage(language)
    ? language
    : DEFAULT_GENERATION_LANGUAGE;
}

export function saveGenerationLanguage(
  language: SupportedGenerationLanguage,
  settingsPath: string = LOCAL_SETTINGS_PATH,
): SupportedGenerationLanguage {
  const settings = readSettingsFile(settingsPath);
  const generation = asObject(settings.generation);

  settings.generation = {
    ...generation,
    language,
  };

  writeSettingsFile(settingsPath, settings);
  return language;
}

export function getAutoGenerate(settingsPath: string = LOCAL_SETTINGS_PATH): boolean {
  const settings = readSettingsFile(settingsPath);
  const autoGenerate = (settings as Record<string, unknown>)['autoGenerate'];
  return autoGenerate === true;
}

export function saveAutoGenerate(
  enabled: boolean,
  settingsPath: string = LOCAL_SETTINGS_PATH,
): boolean {
  const settings = readSettingsFile(settingsPath);
  (settings as Record<string, unknown>)['autoGenerate'] = enabled;
  writeSettingsFile(settingsPath, settings);
  return enabled;
}
