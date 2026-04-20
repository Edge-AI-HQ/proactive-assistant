/**
 * Chat endpoints.
 *
 * Streaming (used by all frontend chat UIs):
 *   POST /chat-stream/send                    — send message, returns SSE stream with reply
 *   POST /chat-stream/init                    — initialize / resume a session
 *   GET  /chat-stream/history?sessionKey=...  — message history
 *
 * Legacy (request/response — kept for programmatic / webhook consumers):
 *   POST /chat                                — single request/response
 *   GET  /chat/history?sessionKey=...         — message history
 *
 * Browser lifecycle events (opened/closed/control) are delivered via a
 * dedicated SSE channel: GET /browser/events?sessionKey=... (see browser.ts).
 */
import type { RouteHandler, RouteContext } from './types.js';
import { json, readBody, extractTextContent } from './types.js';
import { buildChatPrompt, type ChatCardContext } from '../agents/chat.js';
import { normalizeCardChatMessages } from '../chat-feedback/service.js';
import { isMainChatSessionKey } from '../conversation-crystallize/service.js';
import { loadActiveSkillsSection } from '../conversation-crystallize/skill-injection.js';
import * as db from '../db.js';

/**
 * Try to parse a cardContext string as structured JSON.
 * Returns undefined if the input is not valid structured card JSON.
 */
function tryParseCardContext(raw: string | undefined): ChatCardContext | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.title === 'string' && parsed.primaryAction) {
      return parsed as ChatCardContext;
    }
  } catch { /* not JSON — will fall back to rawCardContext */ }
  return undefined;
}

export function resolveIncomingChatMessage(params: {
  message?: string;
  firstMessage?: string;
}): string {
  const userMessage = typeof params.message === 'string' ? params.message.trim() : '';
  return userMessage || params.firstMessage || '';
}

/**
 * Compact single-line preview of tool args for display in the client.
 * Picks well-known detail keys first; falls back to JSON-ish summary.
 * Hard-capped to keep SSE frames small.
 */
const TOOL_ARG_PREVIEW_MAX = 200;
const TOOL_ARG_PREVIEW_KEYS = [
  'command', 'cmd',
  'query', 'q',
  'path', 'file_path',
  'url', 'targetUrl',
  'name', 'tool',
  'sessionKey', 'agentId',
  'input',
] as const;

export function previewToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of TOOL_ARG_PREVIEW_KEYS) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' ? raw : safeStringify(raw);
    if (!value) continue;
    parts.push(`${key}=${value}`);
    if (parts.join(' · ').length >= TOOL_ARG_PREVIEW_MAX) break;
  }
  const preview = parts.join(' · ').trim();
  if (!preview) return undefined;
  return truncate(preview, TOOL_ARG_PREVIEW_MAX);
}

/**
 * Detect invocations of the `pin` CLI (shelled out via the `exec` tool)
 * and return the subcommand portion so the UI can badge it as "PIN CLI".
 */
export function detectPinCommand(
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName !== 'exec') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const command = (args as Record<string, unknown>).command;
  if (typeof command !== 'string') return undefined;
  const trimmed = command.trim();
  const match = trimmed.match(/(?:^|[\s;&|])pin\s+([^\n]+)/);
  if (!match) return undefined;
  return truncate(match[1].trim(), TOOL_ARG_PREVIEW_MAX);
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Load the learned-skills prompt section. Only injected into main-chat
 * sessions — card chat already has its own tightly-scoped card context.
 * Failures never block the chat flow.
 */
async function loadLearnedSkillsSectionSafe(
  ctx: RouteContext,
  sessionKey: string | undefined,
): Promise<string | undefined> {
  if (!isMainChatSessionKey(sessionKey)) return undefined;
  try {
    const section = await loadActiveSkillsSection();
    return section || undefined;
  } catch (err) {
    ctx.api.logger.warn(
      `[chat] loadActiveSkillsSection failed: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

/**
 * Non-blocking hook: increment the cross-session main-chat turn counter when
 * the user sends a real message. Card-chat sessions and card-opener injections
 * are excluded — those flows are handled by chat-feedback.
 */
function bumpCrystallizeTurnSafe(
  ctx: RouteContext,
  sessionKey: string | undefined,
  message: string,
  opts?: { cardOpener?: boolean },
): void {
  if (!sessionKey) return;
  if (opts?.cardOpener) return;
  if (!message || !message.trim()) return;
  if (!isMainChatSessionKey(sessionKey)) return;
  db.bumpCrystallizeTurn(sessionKey).catch((err) => {
    ctx.api.logger.warn(
      `[crystallize] bumpTurn failed: ${err instanceof Error ? err.message : err}`,
    );
  });
}

export function handleChat(): RouteHandler {
  return async (ctx) => {
    // ── GET /chat/history or /chat-stream/history ──
    if ((ctx.subpath === '/chat/history' || ctx.subpath === '/chat-stream/history') && ctx.req.method === 'GET') {
      return handleHistory(ctx);
    }

    // ── POST /chat-stream/init ──
    if (ctx.subpath === '/chat-stream/init' && ctx.req.method === 'POST') {
      const body = await readBody(ctx.req) as { sessionKey?: string };
      const sessionKey = body.sessionKey ?? `agent:main:proactive-ai:chat-test:${Date.now().toString(36)}`;
      try {
        const result = await ctx.api.runtime.subagent.getSessionMessages({ sessionKey, limit: 1 });
        const hasMessages = (result.messages as unknown[]).length > 0;
        if (hasMessages) {
          json(ctx.res, 200, { ok: true, sessionKey, existing: true });
          return true;
        }
      } catch { /* no existing session */ }
      json(ctx.res, 200, { ok: true, sessionKey, existing: false });
      return true;
    }

    // ── POST /chat-stream/send ── send message, return SSE stream with reply ──
    if (ctx.subpath === '/chat-stream/send' && ctx.req.method === 'POST') {
      const body = await readBody(ctx.req) as { message?: string; sessionKey?: string; cardContext?: string };
      const sessionKey = body.sessionKey;
      const rawCardCtx = typeof body.cardContext === 'string' && body.cardContext.trim() ? body.cardContext.trim() : undefined;
      const card = tryParseCardContext(rawCardCtx);
      const learnedSkillsSection = await loadLearnedSkillsSectionSafe(ctx, sessionKey);
      const { systemPrompt, firstMessage } = buildChatPrompt({
        card,
        rawCardContext: card ? undefined : rawCardCtx,
        learnedSkillsSection,
      });
      const message = resolveIncomingChatMessage({
        message: body.message,
        firstMessage,
      });

      if (!sessionKey || !message) {
        json(ctx.res, 400, { error: 'Missing sessionKey; provide message or cardContext' });
        return true;
      }

      bumpCrystallizeTurnSafe(ctx, sessionKey, body.message ?? '', {
        cardOpener: Boolean(card || rawCardCtx),
      });

      // Return SSE stream directly — standard AI chat pattern
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (data: Record<string, unknown>) => {
        try { ctx.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
      };

      write({ type: 'chat:thinking', timestamp: Date.now() });

      try {
        const { runId } = await ctx.api.runtime.subagent.run({
          sessionKey,
          message,
          extraSystemPrompt: systemPrompt,
          idempotencyKey: `proactive-ai:chat-stream:${Date.now().toString(36)}`,
          deliver: false,
        });

        // Stream assistant deltas and tool lifecycle events via the agent
        // event bus. Assistant deltas become chat:delta frames; tool events
        // become chat:tool:{start|update|result} frames so the client can
        // render "Agent is running Exec (pin personal ...)" style status
        // strips inline with the reply.
        let streamed = false;
        let toolEventsSeen = 0;
        const unsubscribe = ctx.api.runtime.events.onAgentEvent((evt) => {
          if (evt.runId !== runId) return;

          if (evt.stream === 'assistant') {
            const delta = evt.data.delta as string | undefined;
            if (!delta) return;
            streamed = true;
            write({ type: 'chat:delta', delta, timestamp: Date.now() });
            return;
          }

          if (evt.stream === 'tool') {
            toolEventsSeen += 1;
            const phase = evt.data.phase as 'start' | 'update' | 'result' | undefined;
            const toolCallId = evt.data.toolCallId as string | undefined;
            const name = evt.data.name as string | undefined;
            if (!phase || !toolCallId || !name) return;

            if (phase === 'start') {
              const args = evt.data.args;
              const argsPreview = previewToolArgs(args);
              const pinCommand = detectPinCommand(name, args);
              ctx.api.logger.info(
                `[chat-stream] tool-start name=${name} toolCallId=${toolCallId}` +
                (pinCommand ? ` pin=${pinCommand}` : '') +
                (argsPreview ? ` args=${argsPreview}` : ''),
              );
              write({
                type: 'chat:tool:start',
                toolCallId,
                name,
                meta: typeof evt.data.meta === 'string' ? evt.data.meta : undefined,
                argsPreview,
                pinCommand,
                timestamp: Date.now(),
              });
              return;
            }

            if (phase === 'update') {
              write({ type: 'chat:tool:update', toolCallId, name, timestamp: Date.now() });
              return;
            }

            if (phase === 'result') {
              const isError = Boolean(evt.data.isError);
              ctx.api.logger.info(
                `[chat-stream] tool-result name=${name} toolCallId=${toolCallId} ` +
                `status=${isError ? 'error' : 'ok'}`,
              );
              write({
                type: 'chat:tool:result',
                toolCallId,
                name,
                isError,
                meta: typeof evt.data.meta === 'string' ? evt.data.meta : undefined,
                timestamp: Date.now(),
              });
              return;
            }
          }
        });

        // Clean up the listener when the client disconnects early.
        ctx.res.on('close', unsubscribe);

        try {
          const result = await ctx.api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });
          if (result.status !== 'ok') {
            write({ type: 'chat:error', error: result.error ?? `Agent failed: ${result.status}` });
            ctx.res.end();
            return true;
          }
        } finally {
          if (toolEventsSeen > 0) {
            ctx.api.logger.info(
              `[chat-stream] run-complete runId=${runId} toolEvents=${toolEventsSeen} streamedText=${streamed}`,
            );
          }
          unsubscribe();
        }

        // If we streamed deltas, send a done marker so the client knows the
        // stream is complete. Otherwise fall back to fetching the final reply
        // (handles edge cases where no delta events fired).
        if (streamed) {
          write({ type: 'chat:done', timestamp: Date.now() });
        } else {
          const messages = await ctx.api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
          const lastReply = (messages.messages as Array<{ role?: string; content?: unknown }>)
            .filter(m => m.role === 'assistant').pop();
          const replyText = extractTextContent(lastReply?.content);
          write({ type: 'chat:reply', content: replyText, timestamp: Date.now() });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.api.logger.error(`[chat-stream] Error: ${errMsg}`);
        write({ type: 'chat:error', error: errMsg });
      }

      ctx.res.end();
      return true;
    }

    // ── POST /chat ── single request/response (CardChat, MainChat) ──
    if (ctx.subpath === '/chat' && ctx.req.method === 'POST') {
      const body = await readBody(ctx.req) as { message?: string; sessionKey?: string; cardContext?: string };
      const sessionKey = body.sessionKey ?? `agent:main:proactive-ai:chat:${Date.now().toString(36)}`;
      const rawCtx = typeof body.cardContext === 'string' && body.cardContext.trim() ? body.cardContext.trim() : undefined;
      const card = tryParseCardContext(rawCtx);
      const learnedSkillsSection = await loadLearnedSkillsSectionSafe(ctx, sessionKey);
      const { systemPrompt, firstMessage } = buildChatPrompt({
        card,
        rawCardContext: card ? undefined : rawCtx,
        learnedSkillsSection,
      });
      const agentMessage = resolveIncomingChatMessage({
        message: body.message,
        firstMessage,
      });
      if (!agentMessage) { json(ctx.res, 400, { error: 'Missing message' }); return true; }

      bumpCrystallizeTurnSafe(ctx, sessionKey, body.message ?? '', {
        cardOpener: Boolean(card || rawCtx),
      });

      try {
        const { runId } = await ctx.api.runtime.subagent.run({
          sessionKey, message: agentMessage,
          extraSystemPrompt: systemPrompt,
          idempotencyKey: `proactive-ai:chat:${Date.now().toString(36)}`, deliver: false,
        });
        const result = await ctx.api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });
        if (result.status !== 'ok') { json(ctx.res, 500, { ok: false, error: result.error ?? `Agent failed: ${result.status}` }); return true; }
        const messages = await ctx.api.runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
        const last = (messages.messages as Array<{ role?: string; content?: unknown }>).filter(m => m.role === 'assistant').pop();
        json(ctx.res, 200, { ok: true, sessionKey, reply: extractTextContent(last?.content) });
      } catch (err) {
        ctx.api.logger.error(`Chat error: ${err instanceof Error ? err.message : err}`);
        json(ctx.res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    return false;
  };
}

async function handleHistory(ctx: RouteContext): Promise<boolean> {
  const sessionKey = ctx.url.searchParams.get('sessionKey');
  if (!sessionKey) { json(ctx.res, 400, { error: 'Missing sessionKey' }); return true; }
  try {
    const result = await ctx.api.runtime.subagent.getSessionMessages({ sessionKey, limit: 50 });
    const messages = normalizeCardChatMessages(result.messages as unknown[])
      .map((message, i) => ({
        id: `${message.role}-${i}`,
        role: message.role,
        content: message.content,
      }));
    json(ctx.res, 200, { ok: true, sessionKey, messages });
  } catch { json(ctx.res, 200, { ok: true, sessionKey, messages: [] }); }
  return true;
}
