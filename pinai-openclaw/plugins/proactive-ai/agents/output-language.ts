import { getGenerationLanguageLabel, type SupportedGenerationLanguage } from './generation-language.js';

export function buildOutputLanguageInstruction(
  language: SupportedGenerationLanguage,
  options: { fieldsDescription: string },
): string {
  const label = getGenerationLanguageLabel(language);
  return `Language: ${options.fieldsDescription} MUST be written in ${label}. JSON keys, schema field names, enums, URLs, IDs, and raw source titles can remain in their original language when needed.`;
}
