import { extractTextContent } from '../helpers.js';

const CODE_FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;

interface SessionMessageLike {
  content?: unknown;
  error?: unknown;
}

export function parseAgentJson<T>(text: string): T | null {
  if (!text) return null;

  const fenceMatch = text.match(CODE_FENCE_RE);
  const jsonStr = fenceMatch ? fenceMatch[1]! : text;

  try {
    return JSON.parse(jsonStr.trim()) as T;
  } catch {
    return null;
  }
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
