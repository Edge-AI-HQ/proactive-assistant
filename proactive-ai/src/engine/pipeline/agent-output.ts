import { extractTextContent } from '../helpers.js';

const CODE_FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
const OPEN_CODE_FENCE_RE = /```(?:json)?\s*\n?([\s\S]*)$/;

interface SessionMessageLike {
  content?: unknown;
  error?: unknown;
}

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return null;
  }
}

function nextNonWhitespaceChar(text: string, start: number): string | null {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch || /\s/.test(ch)) continue;
    return ch;
  }

  return null;
}

function repairUnescapedInnerQuotes(text: string): string {
  let repaired = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      repaired += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      repaired += ch;
      escaped = true;
      continue;
    }

    if (ch !== '"') {
      repaired += ch;
      continue;
    }

    if (!inString) {
      inString = true;
      repaired += ch;
      continue;
    }

    const next = nextNonWhitespaceChar(text, i + 1);
    if (next === null || next === ',' || next === '}' || next === ']' || next === ':') {
      inString = false;
      repaired += ch;
      continue;
    }

    repaired += '\\"';
  }

  return repaired;
}

function tryParseJsonWithRepair<T>(text: string): T | null {
  const parsed = tryParseJson<T>(text);
  if (parsed) return parsed;

  const repaired = repairUnescapedInnerQuotes(text);
  if (repaired === text) return null;

  return tryParseJson<T>(repaired);
}

function extractBalancedJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;

  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === opening) {
      depth += 1;
      continue;
    }

    if (ch === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseAgentJson<T>(text: string): T | null {
  if (!text) return null;

  const trimmed = text.trim();
  const completeFence = text.match(CODE_FENCE_RE)?.[1];
  const openFence = text.match(OPEN_CODE_FENCE_RE)?.[1];
  const balancedFromFence = openFence ? extractBalancedJson(openFence) : null;
  const balanced = extractBalancedJson(text);
  const candidates = [trimmed, completeFence, openFence, balancedFromFence, balanced]
    .filter((candidate): candidate is string => Boolean(candidate));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const parsed = tryParseJsonWithRepair<T>(candidate);
    if (parsed) return parsed;
  }

  return null;
}

export function detectAgentErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (/^HTTP \d{3}\b/i.test(trimmed)) return trimmed;
  if (/^(error|forbidden|unauthorized|request failed)\b[:\s-]*/i.test(trimmed)) return trimmed;
  if (/request not allowed/i.test(trimmed)) return trimmed;

  return null;
}

export function detectAgentErrorInMessages(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as SessionMessageLike | undefined;
    if (!message) continue;

    if (typeof message.error === 'string') {
      const error = detectAgentErrorMessage(message.error);
      if (error) return error;
    }

    const text = extractTextContent(message.content);
    const error = detectAgentErrorMessage(text);
    if (error) return error;
  }

  return null;
}

export function parseAgentJsonOrThrow<T>(text: string, tag: string): T {
  const parsed = parseAgentJson<T>(text);
  if (parsed) return parsed;

  const error = detectAgentErrorMessage(text);
  if (error) {
    throw new Error(`Agent ${tag} failed: ${error}`);
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      `Agent ${tag} returned empty response before producing any output. This usually means the upstream provider failed before generating text.`,
    );
  }

  const preview = trimmed.slice(0, 200);
  throw new Error(`Agent ${tag} returned invalid JSON: ${preview}`);
}
