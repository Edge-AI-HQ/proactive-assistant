/**
 * APIs ⇄ pinai-agents bridge (Step 1.7).
 *
 * Routes three agent-flow paths to the Python service instead of the
 * per-user OpenClaw container:
 *
 *   POST /api/proxy/generate         → pinai-agents POST /agent/generate
 *   POST /api/proxy/chat-stream/send → pinai-agents POST /agent/chat (SSE)
 *   POST /api/proxy/chat-stream/init → APIs self-implements (LangGraph thread lookup)
 *
 * Other /api/proxy/* paths (memory / signals / raw / devices / etc.) keep
 * going to the OpenClaw container via the catch-all proxy until Step 2
 * moves them to the Agent API.
 *
 * Credential injection: APIs reads users.litellm_virtual_key for the
 * authenticated user and adds it to the upstream POST body. The virtual
 * key never reaches the browser.
 *
 * SSE pass-through: response body is piped directly back to the client as
 * Web ReadableStream → Node Readable → res.
 */

import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pool } from '../common/db/core.js';
import { ensureProactiveLiteLLMKey } from './litellm_key_service.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

function getAgentsUrl(): string {
  const url = (process.env['PINAI_AGENTS_URL'] ?? '').trim();
  if (!url) {
    throw new Error('PINAI_AGENTS_URL not configured');
  }
  return url.replace(/\/$/, '');
}

/**
 * Resolve the per-user LiteLLM virtual key. Reuses the existing OpenClaw
 * provisioning path — `ensureProactiveLiteLLMKey` returns the cached key
 * when present and lazily creates a new one (LiteLLM user + key) when not.
 * That way dev users (no prior OpenClaw container creation) and prod users
 * follow the same code path.
 */
async function getVirtualKey(supabaseUserId: string): Promise<string> {
  return ensureProactiveLiteLLMKey(supabaseUserId);
}

/**
 * Map "agent:main:proactive-ai:chat:smoke-..." or "chat:card:..." (used by
 * the frontend chat session bookkeeping) to a LangGraph thread_id. We use
 * the sessionKey verbatim — pinai-agents agents pass it through as
 * `configurable.thread_id`, and the langgraph.checkpoints table stores it
 * as `thread_id`. Keeping them identical means `/chat-stream/init` can
 * answer "does this session already have history" with a single SQL.
 */
async function checkpointExists(threadId: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM langgraph.checkpoints WHERE thread_id = $1) AS exists`,
    [threadId]
  );
  return Boolean(rows[0]?.exists);
}

/** POST /api/proxy/generate → pinai-agents /agent/generate */
export async function generateHandler(req: Request, res: Response): Promise<void> {
  const auth = req.proactiveAuth;
  if (!auth?.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  let virtualKey: string;
  try {
    virtualKey = await getVirtualKey(auth.userId);
  } catch (e) {
    console.error('[agents-proxy] virtual key provisioning failed', e);
    res.status(503).json({ error: 'LiteLLM key provisioning failed', code: 'NO_VIRTUAL_KEY' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const upstreamBody = {
    virtual_key: virtualKey,
    cards_to_generate: typeof body['cardsToGenerate'] === 'number' ? body['cardsToGenerate'] : 4,
    output_language: typeof body['outputLanguage'] === 'string' ? body['outputLanguage'] : 'en',
  };

  try {
    const upstream = await fetch(`${getAgentsUrl()}/agent/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });
    const data = (await upstream.json()) as Record<string, unknown>;
    // Translate snake_case → camelCase for the response shape the frontend
    // expects (TS contract: { runId, status, cards, ... }).
    const out = {
      runId: data['run_id'],
      status: data['status'],
      durationMs: data['duration_ms'],
      reasoning: data['reasoning'],
      cards: data['cards'],
      evaluations: data['evaluations'],
      batchFeedback: data['batch_feedback'],
    };
    res.status(upstream.status).json(out);
  } catch (e) {
    console.error('[agents-proxy] generate failed', e);
    res.status(502).json({ error: 'pinai-agents unreachable', code: 'AGENTS_UNREACHABLE' });
  }
}

/** POST /api/proxy/chat-stream/send → pinai-agents /agent/chat (SSE) */
export async function chatHandler(req: Request, res: Response): Promise<void> {
  const auth = req.proactiveAuth;
  if (!auth?.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  let virtualKey: string;
  try {
    virtualKey = await getVirtualKey(auth.userId);
  } catch (e) {
    console.error('[agents-proxy] virtual key provisioning failed', e);
    res.status(503).json({ error: 'LiteLLM key provisioning failed', code: 'NO_VIRTUAL_KEY' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionKey = typeof body['sessionKey'] === 'string' ? body['sessionKey'] : '';
  const message = typeof body['message'] === 'string' ? body['message'] : '';
  if (!sessionKey || !message) {
    res.status(400).json({ error: 'sessionKey and message are required' });
    return;
  }

  // cardContext from frontend is a JSON string (see card-chat-session.ts
  // buildChatRequestBody). Parse to object for pinai-agents which expects
  // a structured field. Failure to parse → null, which makes pinai-agents
  // route to main chat instructions instead of card chat.
  let cardContext: Record<string, unknown> | null = null;
  if (typeof body['cardContext'] === 'string' && body['cardContext'].length > 0) {
    try {
      const parsed: unknown = JSON.parse(body['cardContext']);
      if (parsed && typeof parsed === 'object') {
        cardContext = parsed as Record<string, unknown>;
      }
    } catch {
      // Bad JSON — log but don't fail the chat send. Card chat downgrades
      // to main chat semantics, which is closer to user intent than 400.
      console.warn('[agents-proxy] cardContext JSON parse failed, sending as main chat');
    }
  }

  const upstreamBody = {
    virtual_key: virtualKey,
    session_key: sessionKey,
    message,
    card_context: cardContext,
  };

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${getAgentsUrl()}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    console.error('[agents-proxy] chat fetch failed', e);
    res.status(502).json({ error: 'pinai-agents unreachable', code: 'AGENTS_UNREACHABLE' });
    return;
  }

  // Forward status + safe headers
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!HOP_BY_HOP.has(k) && k !== 'content-length') {
      res.setHeader(k, value);
    }
  });
  // SSE-friendly headers in case upstream omitted them (it doesn't, but
  // belt-and-suspenders against any edge proxy buffering).
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');

  if (!upstream.body) {
    res.end();
    return;
  }
  // Web ReadableStream → Node Readable → response. fetch() in Node 18+
  // returns a Web stream; Readable.fromWeb adapts it.
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}

/**
 * POST /api/proxy/chat-stream/init → does this session already have history?
 *
 * Replaces OpenClaw's `/chat-stream/init`. The frontend uses `existing` to
 * decide whether to bootstrap a card-chat thread (no prior turns) vs. just
 * load history (turns already present). LangGraph checkpointer stores one+
 * row per turn under the same thread_id → SQL EXISTS is sufficient.
 */
export async function chatInitHandler(req: Request, res: Response): Promise<void> {
  const auth = req.proactiveAuth;
  if (!auth?.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionKey = typeof body['sessionKey'] === 'string' ? body['sessionKey'] : '';
  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey is required' });
    return;
  }
  try {
    const existing = await checkpointExists(sessionKey);
    res.status(200).json({ ok: true, existing });
  } catch (e) {
    console.error('[agents-proxy] chat init failed', e);
    res.status(500).json({ error: 'init failed' });
  }
}
