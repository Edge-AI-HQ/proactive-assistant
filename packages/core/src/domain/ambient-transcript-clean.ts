// Ambient transcript cleanup — lifted verbatim from
// proactive-ai-frontend/src/services/ambient/sources/sound-classifier.ts
// (module-private helpers around cleanAmbientTranscriptText) so the RN
// capture pipeline applies the same boundary-noise stripping / meaningless
// burst filtering as the web/Capacitor source. The dev file keeps its own
// private copy for now (no consumer switch); this is the shared SSOT for
// new consumers.
const MAX_TRANSCRIPT_CLEANUP_PASSES = 20;
const LEADING_BOUNDARY_NOISE_RE = /^[\s\p{Punctuation}\p{Symbol}]+/u;
const TRAILING_BOUNDARY_NOISE_RE = /[\s\p{Punctuation}\p{Symbol}]+$/u;
const LEADING_SUBTITLE_HALLUCINATION_RE = /^(?:thank(?:s| you)? for watching|thanks for watching)[\s\p{Punctuation}\p{Symbol}]+/iu;
const TRAILING_SUBTITLE_HALLUCINATION_RE = /[\s\p{Punctuation}\p{Symbol}]+(?:thank(?:s| you)? for watching|thanks for watching)[\s\p{Punctuation}\p{Symbol}]*$/iu;
const LEADING_WORD_RE = /^[A-Za-z]+/u;
const TRAILING_WORD_RE = /[A-Za-z]+$/u;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z']*/g;
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const NON_CONTENT_RE = /[\s\p{Punctuation}\p{Symbol}]+/gu;
const EDGE_FILLER_WORDS = new Set([
  "ah",
  "er",
  "hey",
  "hi",
  "hello",
  "hm",
  "hmm",
  "jesus",
  "mm",
  "mmm",
  "ok",
  "okay",
  "uh",
  "um",
  "yeah",
  "yep",
  "yes",
]);
const LOW_INFORMATION_WORDS = new Set([
  ...EDGE_FILLER_WORDS,
  "a",
  "am",
  "an",
  "and",
  "are",
  "be",
  "but",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

export function cleanAmbientTranscriptText(value: string): string | null {
  const cleaned = stripBoundaryTranscriptNoise(normalizeTranscriptWhitespace(value));
  if (!isMeaningfulTranscriptText(cleaned)) return null;
  return cleaned;
}

function stripBoundaryTranscriptNoise(value: string): string {
  let text = value;
  for (let pass = 0; pass < MAX_TRANSCRIPT_CLEANUP_PASSES; pass += 1) {
    const before = text;
    text = stripLeadingBoundaryNoise(text);
    text = stripTrailingFillerWord(text);
    if (text === before) break;
  }
  return normalizeTranscriptWhitespace(text);
}

function stripLeadingBoundaryNoise(value: string): string {
  let text = value;
  for (let pass = 0; pass < MAX_TRANSCRIPT_CLEANUP_PASSES; pass += 1) {
    const before = text;
    text = text.replace(LEADING_SUBTITLE_HALLUCINATION_RE, "").trimStart();
    text = text.replace(LEADING_BOUNDARY_NOISE_RE, "").trimStart();
    text = stripLeadingFillerWord(text).trimStart();
    if (text === before) break;
  }
  return text;
}

function stripLeadingFillerWord(value: string): string {
  const match = value.match(LEADING_WORD_RE);
  if (!match || !isFillerWord(match[0])) return value;
  return value.slice(match[0].length);
}

function stripTrailingFillerWord(value: string): string {
  const withoutTrailingNoise = value
    .replace(TRAILING_SUBTITLE_HALLUCINATION_RE, "")
    .replace(TRAILING_BOUNDARY_NOISE_RE, "")
    .trimEnd();
  const match = withoutTrailingNoise.match(TRAILING_WORD_RE);
  if (!match || match.index === undefined || !isFillerWord(match[0])) return value;
  return trimTrailingFillerSeparator(withoutTrailingNoise.slice(0, match.index));
}

function trimTrailingFillerSeparator(value: string): string {
  return value
    .replace(/[\s…·•]+$/gu, "")
    .replace(/(?:\s|\.{2,})+$/gu, "")
    .replace(/[\s,;:、，；：]+$/gu, "")
    .trimEnd();
}

function isMeaningfulTranscriptText(value: string): boolean {
  const compact = value.replace(NON_CONTENT_RE, "");
  if (!compact) return false;

  const cjkChars = value.match(CJK_CHAR_RE)?.length ?? 0;
  if (cjkChars >= 2) return true;

  const words = value.match(LATIN_WORD_RE) ?? [];
  const meaningfulWords = words.filter((word) => !LOW_INFORMATION_WORDS.has(word.toLowerCase()));
  if (meaningfulWords.length >= 2) return true;

  return /\d/u.test(value) && meaningfulWords.length >= 1;
}

function isFillerWord(value: string): boolean {
  const word = value.toLowerCase();
  return EDGE_FILLER_WORDS.has(word) || /^(?:h+mm+|m+|u+h+|u+m+|a+h+|e+r+)$/u.test(word);
}

function normalizeTranscriptWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
