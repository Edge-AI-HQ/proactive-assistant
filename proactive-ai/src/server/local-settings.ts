import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_GENERATION_LANGUAGE,
  isSupportedGenerationLanguage,
  type SupportedGenerationLanguage,
} from "../types/generation-language.js";

interface LocalSettings {
  composio?: Record<string, unknown>;
  generation?: {
    language?: string;
  };
  [key: string]: unknown;
}

const PROFILE_DIR = join(homedir(), ".openclaw-proactive-ai");
const LOCAL_SETTINGS_PATH = join(PROFILE_DIR, "local-settings.json");

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
