import type { ServerResponse } from 'node:http';
import type { RouteContext } from '../types.js';
import { json, readBody } from '../http-utils.js';
import { extractTextContent } from '../../helpers.js';
import { buildChatSystemPrompt, buildChatFirstMessage } from '../../agents/chat.js';
import { normalizeCardChatMessages } from '../../chat-feedback/service.js';
import { memory as coreMemory } from '../../../core/index.js';
import { buildDefaultCtx } from '../../pipeline/data-access.js';

const coreCtx = buildDefaultCtx();

function buildChatMemoryEvent(input: {
  text: string;
  sessionKey: string;
  isFirstTurn: boolean;
  cardContext?: string;
}): {
  profileId: string;
  source: string;
  kind: string;
  subjectType: string;
  subjectKey: string;
  text: string;
  payload: Record<string, unknown>;
  confidence: number;
} {
  return {
    profileId: 'default',
    source: 'chat',
    kind: 'user_said',
    subjectType: 'conversation',
    subjectKey: 'chat',
    text: input.text,
    payload: {
      sessionKey: input.sessionKey,
      isFirstTurn: input.isFirstTurn,
      hasCardContext: Boolean(input.cardContext),
    },
    confidence: 0.95,
  };
}

function sseWrite(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleChat(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res, url, api } = ctx;

  // GET /chat/history
  if (subpath === '/chat/history' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey');
    if (!sessionKey) {
      json(res, 400, { error: 'Missing sessionKey' });
      return true;
    }

    try {
      const result = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 50 });
      const messages = normalizeCardChatMessages(result.messages)
        .map((message, index) => ({
          id: `${message.role}-${index}`,
          role: message.role,
          content: message.content,
        }));
      json(res, 200, { ok: true, sessionKey, messages });
    } catch {
      json(res, 200, { ok: true, sessionKey, messages: [] });
    }
    return true;
  }

  // POST /chat/stream — SSE streaming chat
  if (subpath === '/chat/stream' && req.method === 'POST') {
    const body = await readBody(req) as {
      message?: string;
      sessionKey?: string;
      cardContext?: string;
    };

    const userMessage = body.message?.trim();
    const isFirstTurn = !!body.cardContext;
    const sessionKey = body.sessionKey ?? `agent:main:proactive-ai:chat:${Date.now().toString(36)}`;

    const systemPrompt = isFirstTurn
      ? buildChatSystemPrompt({ cardContext: body.cardContext as string })
      : undefined;

    const agentMessage = isFirstTurn ? buildChatFirstMessage() : userMessage;

    if (!agentMessage) {
      json(res, 400, { error: 'Missing message' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    sseWrite(res, { type: 'start', sessionKey });

    try {
      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: agentMessage,
        ...(systemPrompt && { extraSystemPrompt: systemPrompt }),
        idempotencyKey: `proactive-ai:chat:${Date.now().toString(36)}`,
        deliver: false,
      });

      let lastContent = '';
      let done = false;

      const waitPromise = api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 }).then((result) => {
        done = true;
        return result;
      });

      while (!done) {
        await sleep(500);
        if (done) break;

        try {
          const msgs = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
          const assistantMsgs = (msgs.messages as Array<{ role?: string; content?: unknown }>)
            .filter(m => m.role === 'assistant');
          const last = assistantMsgs[assistantMsgs.length - 1];
          const content = extractTextContent(last?.content) ?? '';

          if (content && content !== lastContent) {
            lastContent = content;
            sseWrite(res, { type: 'delta', content });
          }
        } catch {
          // polling failure is non-fatal; keep waiting for the run
        }
      }

      const result = await waitPromise;

      if (result.status !== 'ok') {
        sseWrite(res, { type: 'error', message: result.error ?? `Agent failed: ${result.status}` });
        res.end();
        return true;
      }

      const finalMsgs = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
      const assistantMsgs = (finalMsgs.messages as Array<{ role?: string; content?: unknown }>)
        .filter(m => m.role === 'assistant');
      const last = assistantMsgs[assistantMsgs.length - 1];
      const finalContent = extractTextContent(last?.content) ?? lastContent;

      sseWrite(res, { type: 'done', content: finalContent, sessionKey });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.error(`Chat stream error: ${message}`);
      sseWrite(res, { type: 'error', message });
      res.end();
    }
    return true;
  }

  // POST /chat — non-streaming (kept for backward compat)
  if (subpath === '/chat' && req.method === 'POST') {
    const body = await readBody(req) as {
      message?: string;
      sessionKey?: string;
      cardContext?: string;
    };

    const userMessage = body.message?.trim();
    const isFirstTurn = !!body.cardContext;
    const sessionKey = body.sessionKey ?? `agent:main:proactive-ai:chat:${Date.now().toString(36)}`;

    const systemPrompt = isFirstTurn
      ? buildChatSystemPrompt({ cardContext: body.cardContext as string })
      : undefined;

    const agentMessage = isFirstTurn ? buildChatFirstMessage() : userMessage;

    if (!agentMessage) {
      json(res, 400, { error: 'Missing message' });
      return true;
    }

    try {
      if (userMessage) {
        try {
          await coreMemory.recordMemoryEvent(
            coreCtx,
            buildChatMemoryEvent({
              text: userMessage,
              sessionKey,
              isFirstTurn,
              cardContext: body.cardContext,
            }),
          );
        } catch {
          // Memory capture is best-effort and must not block chat.
        }
      }

      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: agentMessage,
        ...(systemPrompt && { extraSystemPrompt: systemPrompt }),
        idempotencyKey: `proactive-ai:chat:${Date.now().toString(36)}`,
        deliver: false,
      });

      const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });

      if (result.status !== 'ok') {
        json(res, 500, { ok: false, error: result.error ?? `Agent failed: ${result.status}` });
        return true;
      }

      const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
      const assistantMsgs = (messages.messages as Array<{ role?: string; content?: unknown }>)
        .filter(m => m.role === 'assistant');
      const last = assistantMsgs[assistantMsgs.length - 1];

      json(res, 200, { ok: true, sessionKey, reply: extractTextContent(last?.content) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.error(`Chat error: ${message}`);
      json(res, 500, { ok: false, error: message });
    }
    return true;
  }

  return false;
}
