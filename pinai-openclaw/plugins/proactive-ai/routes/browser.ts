/**
 * Browser session HTTP + SSE endpoints.
 *
 * GET  /browser/events?sessionKey=...  — SSE stream for browser lifecycle events
 * GET  /browser/sessions               — list all sessions
 * POST /browser/sessions               — create a session
 * DELETE /browser/sessions/:id         — destroy a session
 * POST /browser/sessions/:id/control   — change control mode
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import { getSharedBrowserManager } from '../browser/tool.js';
import { browserEvents } from '../browser/events.js';

export function handleBrowser(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/browser/')) return false;

    // ── GET /browser/events — dedicated SSE for browser lifecycle events ──
    if (ctx.subpath === '/browser/events' && ctx.req.method === 'GET') {
      const sessionKey = ctx.url.searchParams.get('sessionKey');
      if (!sessionKey) { json(ctx.res, 400, { error: 'Missing sessionKey' }); return true; }
      ctx.api.logger.info(`[browser-events] SSE connected for sessionKey=${sessionKey}`);

      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (event: string, data: unknown) => {
        try { ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
      };

      // Send current browser state if a session is already active
      const activeSession = browserEvents.getActiveSession(sessionKey);
      if (activeSession) {
        write('browser:opened', activeSession);
      }

      // Subscribe to future events for this sessionKey
      const unsub = browserEvents.on(sessionKey, (event) => {
        write(event.type, event);
      });

      const heartbeat = setInterval(() => {
        try { ctx.res.write(': heartbeat\n\n'); } catch { /* ignore */ }
      }, 15_000);

      write('connected', { sessionKey, timestamp: Date.now() });

      ctx.req.on('close', () => {
        clearInterval(heartbeat);
        unsub();
      });

      return true;
    }

    const mgr = getSharedBrowserManager();

    if (!mgr) {
      json(ctx.res, 503, { error: 'Browser tool not enabled (BROWSERBASE_API_KEY not set)' });
      return true;
    }

    const route = ctx.subpath;

    // GET /browser/sessions
    if (route === '/browser/sessions' && ctx.req.method === 'GET') {
      json(ctx.res, 200, { ok: true, sessions: mgr.listSessions() });
      return true;
    }

    // POST /browser/sessions
    if (route === '/browser/sessions' && ctx.req.method === 'POST') {
      const body = await readBody(ctx.req);
      const subagentId = String(body.subagentId ?? '').trim();
      if (!subagentId) { json(ctx.res, 400, { error: 'Missing subagentId' }); return true; }
      try {
        const session = await mgr.createSession({
          subagentId,
          url: typeof body.url === 'string' ? body.url : undefined,
          viewport: body.viewport as { width: number; height: number } | undefined,
        });
        json(ctx.res, 200, { ok: true, session });
      } catch (err) {
        json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // DELETE /browser/sessions/:id
    const deleteMatch = route.match(/^\/browser\/sessions\/([^/]+)$/);
    if (deleteMatch && ctx.req.method === 'DELETE') {
      const sessionId = deleteMatch[1];
      const session = mgr.getSession(sessionId);
      await mgr.destroySession(sessionId);
      if (session) {
        browserEvents.emit({ type: 'browser:closed', sessionKey: session.subagentId, browserSessionId: sessionId });
      }
      json(ctx.res, 200, { ok: true });
      return true;
    }

    // POST /browser/sessions/:id/control
    const controlMatch = route.match(/^\/browser\/sessions\/([^/]+)\/control$/);
    if (controlMatch && ctx.req.method === 'POST') {
      const sessionId = controlMatch[1];
      const body = await readBody(ctx.req);
      const mode = String(body.mode ?? '').trim();
      if (mode !== 'ai' && mode !== 'user' && mode !== 'idle') {
        json(ctx.res, 400, { error: 'Invalid mode (ai | user | idle)' });
        return true;
      }
      mgr.setControlMode(sessionId, mode);
      const session = mgr.getSession(sessionId);
      if (session) {
        browserEvents.emit({ type: 'browser:control', sessionKey: session.subagentId, browserSessionId: sessionId, mode });
      }
      json(ctx.res, 200, { ok: true, mode });
      return true;
    }

    return false;
  };
}
