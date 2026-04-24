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

const MAX_USER_INPUT_TEXT_LENGTH = 2000;

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

      // Send current browser state if a session is already active.
      // The event bus keeps the latest control state so reconnects do not
      // lose an AI-requested takeover banner.
      //
      // If no session is active, we *still* push a closed marker so that
      // a reconnecting client can drop any stale session it was holding
      // onto (for example after the container restarted or the session
      // was idle-timeout destroyed while the app was backgrounded).
      // Without this the frontend keeps firing /input requests at a
      // dead session id and silently 404s.
      const activeSession = browserEvents.getActiveSession(sessionKey);
      if (activeSession) {
        write('browser:opened', activeSession);
      } else {
        write('browser:closed', { sessionKey, browserSessionId: null });
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
      await mgr.destroySession(sessionId);
      json(ctx.res, 200, { ok: true });
      return true;
    }

    // POST /browser/sessions/:id/refresh-live-view-url
    // Frontend Reload button — when the iframe shows "Debugging connection
    // was closed", the Browserbase signed URL has expired. Re-fetch a fresh
    // one without tearing down the CDP session, return to the client, let
    // the iframe remount with the new src.
    const refreshMatch = route.match(/^\/browser\/sessions\/([^/]+)\/refresh-live-view-url$/);
    if (refreshMatch && ctx.req.method === 'POST') {
      const sessionId = refreshMatch[1];
      if (!mgr.getSession(sessionId)) {
        json(ctx.res, 404, { error: 'Session not found' });
        return true;
      }
      try {
        const liveViewUrl = await mgr.refreshLiveViewUrl(sessionId);
        json(ctx.res, 200, { ok: true, liveViewUrl });
      } catch (err) {
        ctx.api.logger.warn(`[browser] refresh-live-view-url failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        json(ctx.res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
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
      json(ctx.res, 200, { ok: true, mode });
      return true;
    }

    // POST /browser/sessions/:id/heartbeat
    const heartbeatMatch = route.match(/^\/browser\/sessions\/([^/]+)\/heartbeat$/);
    if (heartbeatMatch && ctx.req.method === 'POST') {
      const sessionId = heartbeatMatch[1];
      try {
        mgr.heartbeat(sessionId);
        json(ctx.res, 200, { ok: true });
      } catch (err) {
        json(ctx.res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // POST /browser/sessions/:id/input
    // Native mobile live-view embedding does not get a real remote keyboard
    // from Browserbase. The app sends sanitized input events here, and the
    // manager injects them through Playwright while the user owns control.
    const inputMatch = route.match(/^\/browser\/sessions\/([^/]+)\/input$/);
    if (inputMatch && ctx.req.method === 'POST') {
      const sessionId = inputMatch[1];
      const body = await readBody(ctx.req);
      const type = String(body.type ?? '').trim();
      try {
        if (type === 'text') {
          const text = typeof body.text === 'string' ? body.text : '';
          if (!text) {
            json(ctx.res, 400, { error: 'Missing text' });
            return true;
          }
          if (text.length > MAX_USER_INPUT_TEXT_LENGTH) {
            json(ctx.res, 400, { error: `Text is too long (max ${MAX_USER_INPUT_TEXT_LENGTH} characters)` });
            return true;
          }
          ctx.api.logger.info(`[browser-input] text session=${sessionId} length=${text.length}`);
          await mgr.typeUserInput(sessionId, text);
          json(ctx.res, 200, { ok: true });
          return true;
        }
        if (type === 'key') {
          const key = typeof body.key === 'string' ? body.key.trim() : '';
          if (!key) {
            json(ctx.res, 400, { error: 'Missing key' });
            return true;
          }
          ctx.api.logger.info(`[browser-input] key session=${sessionId} key=${key}`);
          await mgr.pressUserKey(sessionId, key);
          json(ctx.res, 200, { ok: true });
          return true;
        }
        if (type === 'click') {
          const x = typeof body.x === 'number' ? body.x : NaN;
          const y = typeof body.y === 'number' ? body.y : NaN;
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            json(ctx.res, 400, { error: 'Missing or invalid x/y' });
            return true;
          }
          ctx.api.logger.info(`[browser-input] click session=${sessionId} x=${x} y=${y}`);
          await mgr.clickUserAt(sessionId, x, y);
          json(ctx.res, 200, { ok: true });
          return true;
        }
        if (type === 'scroll') {
          const dx = typeof body.dx === 'number' ? body.dx : 0;
          const dy = typeof body.dy === 'number' ? body.dy : 0;
          if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
            json(ctx.res, 400, { error: 'Missing or invalid dx/dy' });
            return true;
          }
          ctx.api.logger.info(`[browser-input] scroll session=${sessionId} dx=${dx} dy=${dy}`);
          await mgr.scrollUser(sessionId, dx, dy);
          json(ctx.res, 200, { ok: true });
          return true;
        }
        json(ctx.res, 400, { error: 'Invalid input type (text | key | click | scroll)' });
      } catch (err) {
        json(ctx.res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    return false;
  };
}
