export const GENERATION_LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "Simplified Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
] as const;

export type SupportedGenerationLanguage = (typeof GENERATION_LANGUAGE_OPTIONS)[number]["value"];
export const DEFAULT_GENERATION_LANGUAGE: SupportedGenerationLanguage = "zh-Hans";
const GENERATION_LANGUAGE_ALIASES: Readonly<Record<string, SupportedGenerationLanguage>> = {
  zh: "zh-Hans",
};

export function isSupportedGenerationLanguage(value: unknown): value is SupportedGenerationLanguage {
  return GENERATION_LANGUAGE_OPTIONS.some((option) => option.value === value);
}

export function parseGenerationLanguage(value: unknown): SupportedGenerationLanguage | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isSupportedGenerationLanguage(trimmed)) return trimmed;
  return GENERATION_LANGUAGE_ALIASES[trimmed] ?? null;
}

export function normalizeGenerationLanguage(
  value: unknown,
  fallback: SupportedGenerationLanguage = DEFAULT_GENERATION_LANGUAGE,
): SupportedGenerationLanguage {
  return parseGenerationLanguage(value) ?? fallback;
}

export function getGenerationLanguageLabel(language: SupportedGenerationLanguage): string {
  const normalized = normalizeGenerationLanguage(language, "en");
  return GENERATION_LANGUAGE_OPTIONS.find((option) => option.value === normalized)?.label ?? "English";
}
