import { MAX_TEXT_CHUNK, MEDIA_DIRECTIVE_RE } from './constants.js';

export const chunkTelegramText = (text: string, maxChunk: number = MAX_TEXT_CHUNK): string[] => {
  if (text.length <= maxChunk) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next = Math.min(cursor + maxChunk, text.length);
    if (next < text.length) {
      const newline = text.lastIndexOf('\n', next);
      if (newline > cursor + 800) {
        next = newline;
      }
    }
    chunks.push(text.slice(cursor, next).trim());
    cursor = next;
  }

  return chunks.filter(Boolean);
};

export const stripMediaDirectivesFromText = (text: string): string => {
  if (!text) return '';
  return text
    .replace(MEDIA_DIRECTIVE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
};
