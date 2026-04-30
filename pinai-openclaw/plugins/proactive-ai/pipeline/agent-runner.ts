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

export interface CollectAgentTextOptions {
  runId: string;
  sessionKey: string;
  timeoutMs: number;
  /**
   * Skip waitForRun and read session messages directly. Used by the startup
   * recovery path where waitForRun against a stale runId would hang for the
   * full timeout because OpenClaw's in-memory wait registry doesn't survive
   * restart.
   */
  skipWait?: boolean;
  /**
   * Predicate that decides whether `text` (the latest assistant message)
   * represents a completed final turn vs a streaming intermediate snapshot.
   *
   * When provided, ALL paths that reach session-read consult this predicate
   * — including a successful waitForRun. The reason: waitForRun has been
   * observed to return ok prematurely (and, more often, return timeout long
   * after the agent finished), so its signal is treated as a hint, not as
   * the source of truth. The session jsonl is the source of truth.
   *
   * If the predicate rejects, we return `timeout` so the caller's retry
   * envelope (reconciler backoff, /generate fast-path → reconciler handoff)
   * can come back later when the agent has actually emitted its final turn.
   *
   * If `validateFinal` is omitted, behavior matches the legacy contract:
   * - waitForRun ok → return ok with whatever extractAgentText finds
   * - waitForRun timeout → return timeout immediately, no session read
   * Callers without a schema (tests, ad-hoc tools) keep the old shape.
   */
  validateFinal?: (text: string) => boolean;
}

/**
 * Wait for a previously-dispatched subagent run to finish, then read its
 * final assistant text. Returns a discriminated result instead of throwing
 * so the reconciler can distinguish "still running" from "fatal" without
 * paying for stack traces in the hot polling loop.
 *
 * Why we always fall through to session-read when `validateFinal` is set:
 * production observation showed `waitForRun` returning timeout 20+ minutes
 * after the agent had already written its final assistant message to the
 * session jsonl (see fly machine 48e619eb060d68 case 2026-04-30, run
 * `run_manual_mokzougs`). The session file IS the durable record; OpenClaw's
 * in-memory wait state is just an optimization. So we use waitForRun to
 * gate latency (skip the file read until the agent should plausibly be
 * done) but always validate the actual session content before declaring ok.
 */
export async function collectAgentText(
  api: OpenClawPluginApi,
  params: CollectAgentTextOptions,
): Promise<CollectAgentResult> {
  // Wait phase — used only to decide WHEN to read the session, not WHETHER
  // the agent is done. error is still terminal (the runtime is telling us
  // something failed structurally, not that it timed out).
  if (!params.skipWait) {
    const wait = await api.runtime.subagent.waitForRun({
      runId: params.runId,
      timeoutMs: params.timeoutMs,
    });
    if (wait.status === 'error') {
      return { status: 'error', error: wait.error ?? 'subagent error' };
    }
    // Legacy mode: no validator means trust waitForRun's verdict. Preserves
    // existing behavior for callers that haven't migrated.
    if (wait.status === 'timeout' && !params.validateFinal) {
      return { status: 'timeout' };
    }
    // wait.status === 'ok' OR (timeout with validator) — fall through to
    // session-read. The validator decides the final outcome.
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
    // Empty session = agent hasn't written anything yet. Treated as
    // "still running" so the caller retries instead of marking the run
    // failed. Legacy behavior reported error here, but with the
    // session-as-truth model, "no text yet" is just a too-early read.
    return params.validateFinal || params.skipWait
      ? { status: 'timeout' }
      : { status: 'error', error: 'agent returned empty text' };
  }

  if (params.validateFinal && !params.validateFinal(text)) {
    // Have text, but caller's schema says it's an intermediate. Wait for
    // the next attempt.
    return { status: 'timeout' };
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
