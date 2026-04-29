/**
 * Agent runner — spawns OpenClaw subagents and extracts their text output.
 *
 * Two layers exist here on purpose:
 *
 *   - dispatchAgent / collectAgentText: split lifecycle so the durable
 *     pipeline (dispatch → DB row → reconciler) can own each half. Use these
 *     when the caller needs to survive process restart or HTTP timeout.
 *
 *   - runAgent: synchronous wait-and-collect. Convenient for tests and
 *     short-lived helpers. NOT safe to use for production /generate flows
 *     because waitForRun() that times out leaves the agent's eventual output
 *     unrecoverable.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { jsonrepair } from 'jsonrepair';

export interface DispatchAgentResult {
  runId: string;
  sessionKey: string;
}

/**
 * Kick off a subagent run without waiting for it to finish. The caller is
 * responsible for persisting `runId` + `sessionKey` somewhere durable so a
 * later collectAgentText() (possibly in a different process tick) can resume.
 */
export async function dispatchAgent(
  api: OpenClawPluginApi,
  tag: string,
  systemPrompt: string,
  userMessage: string,
): Promise<DispatchAgentResult> {
  const nonce = Date.now().toString(36);
  const sessionKey = `agent:main:proactive-ai:${tag}:${nonce}`;
  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: systemPrompt,
    idempotencyKey: `proactive-ai:${tag}:${nonce}`,
    message: userMessage,
    deliver: false,
  });
  return { runId, sessionKey };
}

export type CollectAgentStatus = 'ok' | 'timeout' | 'error';

export interface CollectAgentResult {
  status: CollectAgentStatus;
  text?: string;
  error?: string;
}

/**
 * Wait for a previously-dispatched subagent run to finish, then read its
 * final assistant text. Returns a discriminated result instead of throwing
 * so the reconciler can distinguish "still running" from "fatal" without
 * paying for stack traces in the hot polling loop.
 *
 * Pass `skipWait=true` after a process restart: waitForRun against a stale
 * runId will hang for the full timeout because the gateway's in-memory cache
 * is gone. Reading session messages directly is the only thing that can
 * salvage agent text written before the crash.
 */
export async function collectAgentText(
  api: OpenClawPluginApi,
  params: { runId: string; sessionKey: string; timeoutMs: number; skipWait?: boolean },
): Promise<CollectAgentResult> {
  if (!params.skipWait) {
    const wait = await api.runtime.subagent.waitForRun({
      runId: params.runId,
      timeoutMs: params.timeoutMs,
    });
    if (wait.status === 'timeout') return { status: 'timeout' };
    if (wait.status === 'error') {
      return { status: 'error', error: wait.error ?? 'subagent error' };
    }
  }

  const messages = await api.runtime.subagent.getSessionMessages({
    sessionKey: params.sessionKey,
    limit: 10,
  });
  const messageError = detectAgentErrorInMessages(messages.messages as unknown[]);
  if (messageError) {
    return { status: 'error', error: messageError };
  }
  const text = extractAgentText(messages);
  if (!text) {
    return { status: 'error', error: 'agent returned empty text' };
  }
  return { status: 'ok', text };
}

export async function runAgent(
  api: OpenClawPluginApi,
  tag: string,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number,
): Promise<string> {
  const dispatched = await dispatchAgent(api, tag, systemPrompt, userMessage);
  const result = await collectAgentText(api, {
    runId: dispatched.runId,
    sessionKey: dispatched.sessionKey,
    timeoutMs,
  });
  if (result.status === 'ok' && result.text) return result.text;
  if (result.status === 'timeout') {
    throw new Error(`Agent ${tag} failed: timeout`);
  }
  throw new Error(`Agent ${tag} failed: ${result.error ?? 'unknown'}`);
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
  const raw = match[1];
  try { return JSON.parse(raw) as T; } catch { /* fall through to repair */ }
  // LLMs (especially with CJK content) regularly emit unescaped " inside
  // strings or trailing commas. jsonrepair handles those structural quirks
  // without us having to babysit the prompt for every model.
  try { return JSON.parse(jsonrepair(raw)) as T; } catch { return null; }
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

export function detectAgentErrorInMessages(messages: unknown[]): string | null {
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
