import type { RouteContext } from '../types.js';
import { json, readBody } from '../http-utils.js';
import { extractTextContent } from '../../helpers.js';
import { buildChatSystemPrompt, buildChatFirstMessage } from '../../agents/chat.js';

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
      const firstTurnPrompt = buildChatFirstMessage();
      const seenAssistant = new Set<string>();
      const messages = (result.messages as Array<{ role?: string; content?: unknown }>)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map((m, i) => ({
          id: `${m.role}-${i}`,
          role: m.role as string,
          content: extractTextContent(m.content),
        }))
        .filter(m => {
          if (!m.content) return false;
          if (m.role === 'user' && m.content.includes(firstTurnPrompt)) return false;
          if (m.role === 'assistant') {
            if (seenAssistant.has(m.content)) return false;
            seenAssistant.add(m.content);
          }
          return true;
        });
      json(res, 200, { ok: true, sessionKey, messages });
    } catch {
      json(res, 200, { ok: true, sessionKey, messages: [] });
    }
    return true;
  }

  // POST /chat
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
