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
  const direct = tryParseJson<T>(trimmed);
  if (direct) return direct;

  const completeFence = text.match(CODE_FENCE_RE)?.[1];
  if (completeFence) {
    const parsedFence = tryParseJson<T>(completeFence);
    if (parsedFence) return parsedFence;
  }

  const openFence = text.match(OPEN_CODE_FENCE_RE)?.[1];
  if (openFence) {
    const parsedOpenFence = tryParseJson<T>(openFence);
    if (parsedOpenFence) return parsedOpenFence;

    const balancedFromFence = extractBalancedJson(openFence);
    if (balancedFromFence) {
      const parsedBalancedFence = tryParseJson<T>(balancedFromFence);
      if (parsedBalancedFence) return parsedBalancedFence;
    }
  }

  const balanced = extractBalancedJson(text);
  if (!balanced) return null;

  return tryParseJson<T>(balanced);
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
