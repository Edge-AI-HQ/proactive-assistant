export interface VoiceLanguageHint {
  openai?: string;
  browser: string;
}

const MIXED_LANGUAGE: VoiceLanguageHint = {
  openai: "zh",
  browser: "zh-CN",
};

const CHINESE_LANGUAGE: VoiceLanguageHint = {
  openai: "zh",
  browser: "zh-CN",
};

const LANGUAGE_HINTS: Record<string, VoiceLanguageHint> = {
  en: { openai: "en", browser: "en-US" },
  "zh-hans": CHINESE_LANGUAGE,
  zh: CHINESE_LANGUAGE,
  "zh-cn": CHINESE_LANGUAGE,
  ja: { openai: "ja", browser: "ja-JP" },
  ko: { openai: "ko", browser: "ko-KR" },
  es: { openai: "es", browser: "es-ES" },
  fr: { openai: "fr", browser: "fr-FR" },
  de: { openai: "de", browser: "de-DE" },
  pt: { openai: "pt", browser: "pt-PT" },
};

export function normalizeVoiceLanguage(language: string | null | undefined): VoiceLanguageHint {
  const key = (language ?? "").trim().replace("_", "-").toLowerCase();
  if (!key || key === "auto" || key === "mixed") return MIXED_LANGUAGE;
  if (LANGUAGE_HINTS[key]) return LANGUAGE_HINTS[key];

  const base = key.split("-", 1)[0];
  return LANGUAGE_HINTS[base] ?? MIXED_LANGUAGE;
}
