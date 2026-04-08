import { getGenerationLanguageLabel, type SupportedGenerationLanguage } from "../types/generation-language.js";

interface OutputLanguageInstructionOptions {
  fieldsDescription: string;
}

export function buildOutputLanguageInstruction(
  language: SupportedGenerationLanguage,
  options: OutputLanguageInstructionOptions,
): string {
  const label = getGenerationLanguageLabel(language);

  return `Language: ${options.fieldsDescription} MUST be written in ${label}. JSON keys, schema field names, enums, URLs, IDs, and raw source titles can remain in their original language when needed.`;
}
