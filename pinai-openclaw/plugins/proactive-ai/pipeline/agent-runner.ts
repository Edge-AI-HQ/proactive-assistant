/**
 * Agent runner — spawns OpenClaw subagents and extracts their text output.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

export async function runAgent(
  api: OpenClawPluginApi,
  tag: string,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number,
): Promise<string> {
  const sessionKey = `agent:main:proactive-ai:${tag}:${Date.now().toString(36)}`;

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: systemPrompt,
    idempotencyKey: `proactive-ai:${tag}:${Date.now().toString(36)}`,
    message: userMessage,
    deliver: false,
  });

  const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs });
  if (result.status !== 'ok') {
    throw new Error(`Agent ${tag} failed: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
  }

  const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });

  // Check for error messages
  const messageError = detectAgentErrorInMessages(messages.messages as unknown[]);
  if (messageError) throw new Error(`Agent ${tag} failed: ${messageError}`);

  return extractAgentText(messages);
}

function extractAgentText(messages: { messages: unknown[] }): string {
  const assistantMsgs = (messages.messages as Array<{ role?: string; content?: unknown }>)
    .filter(m => m.role === 'assistant');
  const last = assistantMsgs[assistantMsgs.length - 1];
  if (!last?.content) return '';
  if (typeof last.content === 'string') return last.content.trim();
  if (Array.isArray(last.content)) {
    return (last.content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
      .trim();
  }
  return '';
}

export function parseAgentJson<T>(text: string): T | null {
  if (!text) return null;
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!match?.[1]) return null;
  try { return JSON.parse(match[1]) as T; } catch { return null; }
}

export function parseAgentJsonOrThrow<T>(text: string, tag: string): T {
  const parsed = parseAgentJson<T>(text);
  if (parsed) return parsed;

  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Agent ${tag} returned empty response`);

  const errorMsg = detectAgentErrorMessage(trimmed);
  if (errorMsg) throw new Error(`Agent ${tag} failed: ${errorMsg}`);

  throw new Error(`Agent ${tag} returned invalid JSON: ${trimmed.slice(0, 200)}`);
}

function detectAgentErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^HTTP \d{3}\b/i.test(trimmed)) return trimmed;
  if (/^(error|forbidden|unauthorized|request failed)\b[:\s-]*/i.test(trimmed)) return trimmed;
  if (/request not allowed/i.test(trimmed)) return trimmed;
  return null;
}

function detectAgentErrorInMessages(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { error?: string; content?: unknown } | undefined;
    if (!msg) continue;
    if (typeof msg.error === 'string') {
      const err = detectAgentErrorMessage(msg.error);
      if (err) return err;
    }
    const text = typeof msg.content === 'string' ? msg.content :
      Array.isArray(msg.content) ? (msg.content as Array<{ type?: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    const err = detectAgentErrorMessage(text);
    if (err) return err;
  }
  return null;
}
