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

export function isSupportedGenerationLanguage(value: unknown): value is SupportedGenerationLanguage {
  return GENERATION_LANGUAGE_OPTIONS.some((option) => option.value === value);
}

export function getGenerationLanguageLabel(language: SupportedGenerationLanguage): string {
  return GENERATION_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? "English";
}
