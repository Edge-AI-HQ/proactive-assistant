import { CUSTOM_SKILL_KEYS } from "./generated_custom_skill_keys.js";

type UnknownRecord = Record<string, unknown>;

export const SKILLS_METADATA_KEY = "openclaw_skills";

export interface OpenclawSkillEntry {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}

export interface OpenclawSkillsConfig {
  allowBundled?: string[];
  entries?: Record<string, OpenclawSkillEntry>;
  load?: {
    watch?: boolean;
    watchDebounceMs?: number;
    extraDirs?: string[];
  };
  install?: {
    preferBrew?: boolean;
    nodeManager?: string;
  };
}

export interface SkillCatalogItem {
  key: string;
  name: string;
  description: string;
}

export const DEFAULT_SKILLS_CATALOG: SkillCatalogItem[] = [
  {
    key: "gws",
    name: "Google Workspace Core",
    description: "Shared Google Workspace CLI access.",
  },
  {
    key: "gws-gmail",
    name: "Gmail",
    description: "Read and search Gmail with Google Workspace CLI.",
  },
  {
    key: "gws-shared",
    name: "Google Workspace Shared",
    description: "Shared Google Workspace auth and helper utilities.",
  },
  {
    key: "gemini",
    name: "Gemini",
    description: "Google Gemini model integration skill.",
  },
  {
    key: "sag",
    name: "Search And Grounding",
    description: "Web grounding and search enhancement skill.",
  },
  {
    key: "peekaboo",
    name: "Peekaboo",
    description: "Snapshot and page peek utility skill.",
  },
  {
    key: "nano-banana-pro",
    name: "Nano Banana Pro",
    description: "Advanced multimodal agent enhancement skill.",
  },
  {
    key: "openai-whisper-api",
    name: "OpenAI Whisper API",
    description: "Speech-to-text transcription via OpenAI Whisper API.",
  },
  {
    key: "openai-image-gen",
    name: "OpenAI Image Gen",
    description: "Image generation via OpenAI DALL-E / image API.",
  },
];

/** Skills always injected into every assistant config — both when runtime
 *  metadata exists (via readSkillsConfigFromRuntimeMetadata) and as the
 *  fallback when no metadata is present (via buildAssistantOpenclawConfig).
 *  Auto-generated from infra/container-manager/images/openclaw/skills/ via
 *  scripts/sync-skills-manifest.mjs — run it after adding/removing skills. */
export const DEFAULT_PREINSTALLED_BUNDLED_SKILLS = CUSTOM_SKILL_KEYS;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
};

const uniqueSorted = (items: string[]): string[] =>
  Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));

const normalizeSkillEntry = (value: unknown): OpenclawSkillEntry | null => {
  if (!isRecord(value)) return null;
  const next: OpenclawSkillEntry = {};

  if (typeof value.enabled === "boolean") {
    next.enabled = value.enabled;
  }
  if (typeof value.apiKey === "string" && value.apiKey.trim()) {
    next.apiKey = value.apiKey.trim();
  }
  if (isRecord(value.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.env)) {
      if (typeof v === "string" && k.trim()) {
        env[k.trim()] = v;
      }
    }
    if (Object.keys(env).length > 0) {
      next.env = env;
    }
  }

  return Object.keys(next).length > 0 ? next : {};
};

export const normalizeOpenclawSkillsConfig = (
  value: unknown,
): OpenclawSkillsConfig | null => {
  if (!isRecord(value)) return null;

  const next: OpenclawSkillsConfig = {};

  const allowBundled = uniqueSorted(toStringArray(value.allowBundled));
  if (allowBundled.length > 0) {
    next.allowBundled = allowBundled;
  }

  if (isRecord(value.entries)) {
    const entries: Record<string, OpenclawSkillEntry> = {};
    for (const [key, rawEntry] of Object.entries(value.entries)) {
      const normalizedKey = key.trim();
      if (!normalizedKey) continue;
      const normalizedEntry = normalizeSkillEntry(rawEntry);
      if (!normalizedEntry) continue;
      entries[normalizedKey] = normalizedEntry;
    }
    if (Object.keys(entries).length > 0) {
      const sortedEntries: Record<string, OpenclawSkillEntry> = {};
      Object.keys(entries)
        .sort((a, b) => a.localeCompare(b))
        .forEach((key) => {
          sortedEntries[key] = entries[key] as OpenclawSkillEntry;
        });
      next.entries = sortedEntries;
    }
  }

  if (isRecord(value.load)) {
    const load: NonNullable<OpenclawSkillsConfig["load"]> = {};
    if (typeof value.load.watch === "boolean") {
      load.watch = value.load.watch;
    }
    if (
      typeof value.load.watchDebounceMs === "number" &&
      Number.isFinite(value.load.watchDebounceMs)
    ) {
      load.watchDebounceMs = Math.trunc(value.load.watchDebounceMs);
    }
    const extraDirs = uniqueSorted(toStringArray(value.load.extraDirs));
    if (extraDirs.length > 0) {
      load.extraDirs = extraDirs;
    }
    if (Object.keys(load).length > 0) {
      next.load = load;
    }
  }

  if (isRecord(value.install)) {
    const install: NonNullable<OpenclawSkillsConfig["install"]> = {};
    if (typeof value.install.preferBrew === "boolean") {
      install.preferBrew = value.install.preferBrew;
    }
    if (
      typeof value.install.nodeManager === "string" &&
      value.install.nodeManager.trim()
    ) {
      install.nodeManager = value.install.nodeManager.trim();
    }
    if (Object.keys(install).length > 0) {
      next.install = install;
    }
  }

  return Object.keys(next).length > 0 ? next : null;
};

export const ensureBundledSkillsInstalled = (
  current: OpenclawSkillsConfig | null,
  skillKeys: readonly string[],
): OpenclawSkillsConfig => {
  let next = normalizeOpenclawSkillsConfig(current || {}) || {};
  skillKeys.forEach((skillKey) => {
    next = installSkillToConfig(next, skillKey);
  });
  return next;
};

export const readSkillsConfigFromRuntimeMetadata = (
  metadata: unknown,
): OpenclawSkillsConfig | null => {
  if (!isRecord(metadata)) return null;
  return ensureBundledSkillsInstalled(
    normalizeOpenclawSkillsConfig(metadata[SKILLS_METADATA_KEY]),
    DEFAULT_PREINSTALLED_BUNDLED_SKILLS,
  );
};

export const installSkillToConfig = (
  current: OpenclawSkillsConfig | null,
  skillKeyRaw: string,
): OpenclawSkillsConfig => {
  const skillKey = skillKeyRaw.trim();
  const base = normalizeOpenclawSkillsConfig(current || {}) || {};
  const entries = { ...(base.entries || {}) };
  const prev = entries[skillKey] || {};
  entries[skillKey] = { ...prev, enabled: true };
  const allowBundled = uniqueSorted([...(base.allowBundled || []), skillKey]);
  return {
    ...base,
    entries,
    allowBundled,
  };
};

export const uninstallSkillFromConfig = (
  current: OpenclawSkillsConfig | null,
  skillKeyRaw: string,
): OpenclawSkillsConfig => {
  const skillKey = skillKeyRaw.trim();
  const base = normalizeOpenclawSkillsConfig(current || {}) || {};
  const entries = { ...(base.entries || {}) };
  const prev = entries[skillKey] || {};
  entries[skillKey] = { ...prev, enabled: false };
  const allowBundled = uniqueSorted(
    (base.allowBundled || []).filter((item) => item !== skillKey),
  );

  return {
    ...base,
    entries,
    ...(allowBundled.length > 0 ? { allowBundled } : {}),
  };
};

export const toOpenclawSkillsPayload = (
  config: OpenclawSkillsConfig | null,
): UnknownRecord | null => {
  const normalized = normalizeOpenclawSkillsConfig(config);
  if (!normalized) return null;
  return normalized as UnknownRecord;
};

export const buildSkillViewList = (
  config: OpenclawSkillsConfig | null,
  catalog: SkillCatalogItem[] = DEFAULT_SKILLS_CATALOG,
): Array<SkillCatalogItem & { installed: boolean; enabled: boolean }> => {
  const normalized = normalizeOpenclawSkillsConfig(config);
  const entries = normalized?.entries || {};
  const allowBundled = new Set(normalized?.allowBundled || []);

  return catalog.map((item) => {
    const entry = entries[item.key];
    const enabled = entry?.enabled !== false;
    const installed = allowBundled.has(item.key) || Boolean(entry);
    return {
      ...item,
      installed,
      enabled,
    };
  });
};
