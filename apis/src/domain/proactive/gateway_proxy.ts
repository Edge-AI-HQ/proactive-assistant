/**
 * Gateway UI reverse proxy.
 *
 * The OpenClaw gateway UI runs inside the user's Fly container (loopback-bound).
 * This proxy exposes it externally via /api/gateway/* with secure ticket-based auth.
 *
 * Flow:
 *   1. Frontend calls POST /api/proactive/gateway/ticket (JWT-authed) → receives { ticket, url }
 *   2. Frontend opens /api/gateway/?ticket=<signed> in a new tab
 *   3. This proxy validates the ticket, sets a session cookie, then redirects
 *   4. Subsequent requests use the session cookie for auth
 *
 * Security:
 *   - Tickets expire in 60 seconds
 *   - Session cookies are httpOnly, sameSite=strict, expire in 1 hour
 *   - The gateway_token is injected by the proxy (never exposed to browser)
 */

import http from 'node:http';
import type { Request, Response } from 'express';
import type { ProactiveContainerOrchestrator } from './container_orchestrator.js';
import { validateTicket, setSessionCookie, getSessionUserId } from './gateway_session.js';

// See container_proxy.ts for rationale — keep-alive disabled to dodge
// stale sockets after OpenClaw SIGUSR1 reload.
const gatewayProxyAgent = new http.Agent({ keepAlive: false });

/**
 * Gateway UI proxy handler.
 *
 * Auth: ticket query param (first request) → session cookie (subsequent)
 */
export function createGatewayProxy(orchestrator: ProactiveContainerOrchestrator) {
  return async function gatewayProxyHandler(req: Request, res: Response): Promise<void> {
    let userId: string | null = null;

    // 1. Check ticket param (first request — opens in new tab)
    const ticket = req.query.ticket as string | undefined;
    if (ticket) {
      userId = validateTicket(ticket);
      if (!userId) {
        res.status(401).send('Invalid or expired ticket. Please re-open from the app.');
        return;
      }

      setSessionCookie(res, userId);

      // Redirect to remove ticket from URL (prevents sharing/bookmarking)
      const cleanUrl = req.originalUrl.replace(/[?&]ticket=[^&]+/, '').replace(/\?$/, '') || '/api/gateway/';
      res.redirect(302, cleanUrl);
      return;
    }

    // 2. Check session cookie
    userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated. Open gateway from the app.' });
      return;
    }

    // 3. Get container (reconcile with runtime to avoid stale records)
    const container = await orchestrator.reconcileContainer(userId);
    if (!container || container.status !== 'running') {
      res.status(503).send('Container not running');
      return;
    }

    // 4. Resolve target
    const target = orchestrator.resolveTarget(container);
    if (!target) {
      res.status(503).send('Cannot resolve container');
      return;
    }

    // 5. Rewrite path: /api/gateway/foo → /foo
    const proxyPath = req.originalUrl
      .replace(/^\/api\/gateway\/?/, '/')
      .replace(/[?&]ticket=[^&]+/, '')
      .replace(/\?$/, '') || '/';

    const targetUrl = new URL(proxyPath, target.httpBaseUrl);

    // 6. Proxy headers
    const proxyHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'connection', 'transfer-encoding'].includes(key)) {
        proxyHeaders[key] = value;
      }
    }
    proxyHeaders['authorization'] = `Bearer ${container.container_proxy_secret}`;
    proxyHeaders['host'] = target.hostOverride ?? new URL(target.httpBaseUrl).host;
    if (target.hostOverride) {
      proxyHeaders['origin'] = `http://${target.hostOverride}`;
    }

    // 7. Proxy request
    const proxyReq = http.request(
      targetUrl,
      {
        method: req.method,
        headers: proxyHeaders,
        agent: gatewayProxyAgent,
        timeout: 30_000,
      },
      (proxyRes) => {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value && !['transfer-encoding', 'connection'].includes(key)) {
            responseHeaders[key] = value as string | string[];
          }
        }
        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      console.error(`[gateway-proxy] Error for user ${userId}:`, err.message);
      if (!res.headersSent) {
        res.status(502).send('Gateway proxy error');
      } else {
        res.end();
      }
    });

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (req.body && typeof req.body === 'object') {
        const bodyStr = JSON.stringify(req.body);
        proxyReq.setHeader('content-type', 'application/json');
        proxyReq.setHeader('content-length', Buffer.byteLength(bodyStr));
        proxyReq.end(bodyStr);
      } else {
        req.pipe(proxyReq);
      }
    } else {
      proxyReq.end();
    }
  };
}
