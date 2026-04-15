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

/** Marker prefix injected into system-generated first messages for history filtering. */
const INJECTED_MSG_PREFIX = 'The user opened ';

export function resolveIncomingChatMessage(params: {
  message?: string;
  firstMessage?: string;
}): string {
  const userMessage = typeof params.message === 'string' ? params.message.trim() : '';
  return userMessage || params.firstMessage || '';
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
      const { systemPrompt, firstMessage } = buildChatPrompt({
        card,
        rawCardContext: card ? undefined : rawCardCtx,
      });
      const message = resolveIncomingChatMessage({
        message: body.message,
        firstMessage,
      });

      if (!sessionKey || !message) {
        json(ctx.res, 400, { error: 'Missing sessionKey; provide message or cardContext' });
        return true;
      }

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

        // Stream assistant deltas as they arrive via the agent event bus.
        // The listener fires on every LLM token; we forward only assistant
        // deltas for this specific run, then clean up once the run ends.
        let streamed = false;
        const unsubscribe = ctx.api.runtime.events.onAgentEvent((evt) => {
          if (evt.runId !== runId) return;
          if (evt.stream !== 'assistant') return;
          const delta = evt.data.delta as string | undefined;
          if (!delta) return;
          streamed = true;
          write({ type: 'chat:delta', delta, timestamp: Date.now() });
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
      const { systemPrompt, firstMessage } = buildChatPrompt({
        card,
        rawCardContext: card ? undefined : rawCtx,
      });
      const agentMessage = resolveIncomingChatMessage({
        message: body.message,
        firstMessage,
      });
      if (!agentMessage) { json(ctx.res, 400, { error: 'Missing message' }); return true; }

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
    const seenAssistant = new Set<string>();
    const messages = (result.messages as Array<{ role?: string; content?: unknown }>)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => ({ id: `${m.role}-${i}`, role: m.role as string, content: extractTextContent(m.content) }))
      .filter(m => {
        if (!m.content) return false;
        // Hide injected first-turn messages (system-generated, not user-typed)
        if (m.role === 'user' && m.content.startsWith(INJECTED_MSG_PREFIX)) return false;
        if (m.role === 'assistant') { if (seenAssistant.has(m.content)) return false; seenAssistant.add(m.content); }
        return true;
      });
    json(ctx.res, 200, { ok: true, sessionKey, messages });
  } catch { json(ctx.res, 200, { ok: true, sessionKey, messages: [] }); }
  return true;
}
