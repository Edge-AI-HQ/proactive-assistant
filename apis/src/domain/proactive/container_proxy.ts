/**
 * SSE-aware reverse proxy to user's OpenClaw container.
 *
 * Routes: /api/proxy/* → container's /proactive-ai/api/*
 * Auth: requireProactiveAuth verifies JWT before proxying.
 * The proxy adds the container's gateway_token for container-level auth.
 */

import type { Request, Response } from 'express';
import http from 'node:http';
import type { ProactiveContainerOrchestrator } from './container_orchestrator.js';
import { getContainerForUser } from './user_service.js';

/**
 * Dedicated agent for /api/proxy/* requests with keep-alive disabled.
 *
 * OpenClaw fires SIGUSR1 reloads on plugin install / model change, closing
 * every WebSocket and HTTP socket on the gateway side. A keep-alive pool on
 * apis would happily hand out those (now-dead) sockets to the next request,
 * which then surfaces as `socket hang up`. Burning a fresh TCP connection
 * per proxied request is sub-millisecond on host.docker.internal, well
 * worth the trade for invariant correctness.
 */
const proxyAgent = new http.Agent({ keepAlive: false });
const LONG_RUNNING_PROXY_TIMEOUT_MS = 600_000;
const HEALTH_PROXY_TIMEOUT_MS = 4_000;

export function rewriteProactiveProxyPath(originalUrl: string): string {
  return originalUrl.replace(/^\/api\/proxy\/?/, '/proactive-ai/api/');
}

export function getProactiveProxyTimeoutMs(method: string, proxyPath: string): number {
  const pathname = proxyPath.split('?', 1)[0];
  if (method.toUpperCase() === 'GET' && pathname === '/proactive-ai/api/health') {
    return HEALTH_PROXY_TIMEOUT_MS;
  }
  return LONG_RUNNING_PROXY_TIMEOUT_MS;
}

export function createProactiveProxy(orchestrator: ProactiveContainerOrchestrator) {
  return async function proxyHandler(req: Request, res: Response): Promise<void> {
    const auth = req.proactiveAuth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Reconcile DB with runtime before trusting container state
    // (last_active_at is refreshed by requireProactiveAuth's upsertUser)
    let container = await orchestrator.reconcileContainer(auth.userId);

    if (!container) {
      res.status(503).json({ error: 'Container not ready', code: 'NO_CONTAINER' });
      return;
    }

    if (container.status === 'suspended') {
      // Auto-resume
      try {
        await orchestrator.resumeContainer(auth.userId);
        container = await getContainerForUser(auth.userId);
        if (!container || container.status !== 'running') {
          res.status(503).json({ error: 'Container resuming, retry shortly', code: 'RESUMING' });
          return;
        }
      } catch (err) {
        console.error(`[proxy] Failed to resume container for ${auth.userId}`, err);
        res.status(503).json({ error: 'Failed to resume container', code: 'RESUME_FAILED' });
        return;
      }
    }

    if (container.status !== 'running') {
      res.status(503).json({
        error: `Container is ${container.status}`,
        code: 'CONTAINER_NOT_RUNNING',
        status: container.status,
      });
      return;
    }

    // Resolve target
    const target = orchestrator.resolveTarget(container);
    if (!target) {
      res.status(503).json({ error: 'Cannot resolve container target', code: 'NO_TARGET' });
      return;
    }

    // Rewrite path: /api/proxy/generate → /proactive-ai/api/generate
    const proxyPath = rewriteProactiveProxyPath(req.originalUrl);
    const upstreamTimeoutMs = getProactiveProxyTimeoutMs(req.method, proxyPath);

    // Proxy the request
    const targetUrl = new URL(proxyPath, target.httpBaseUrl);

    const proxyHeaders: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>,
      Authorization: `Bearer ${container.container_proxy_secret}`,
      host: target.hostOverride ?? new URL(target.httpBaseUrl).host,
    };

    // Remove hop-by-hop headers
    delete proxyHeaders['transfer-encoding'];
    delete proxyHeaders['connection'];

    if (target.hostOverride) {
      proxyHeaders['origin'] = `http://${target.hostOverride}`;
    }

    // Body has to be replayable for retries to be safe. JSON bodies on
    // POST/PUT/PATCH get serialized once and re-sent on each attempt; raw
    // request streams (the legacy fallback below) can only be consumed
    // once, so we mark those non-retryable.
    const methodHasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
    let bufferedBody: string | null = null;
    let canRetryBody = true;
    if (methodHasBody) {
      if (req.body && typeof req.body === 'object') {
        bufferedBody = JSON.stringify(req.body);
      } else {
        // Raw stream — pipe directly, but this means we can't retry.
        canRetryBody = false;
      }
    }

    /**
     * Transient TCP-level errors that signal the upstream socket vanished
     * mid-handshake. The user's gateway sends SIGUSR1 to reload itself
     * after a config.patch (model change), which closes idle keep-alive
     * sockets the apis container is still holding. Without a retry, the
     * very next /api/proxy/* request 502s and the frontend's readiness
     * loop reports loading forever.
     */
    const isTransient = (err: Error & { code?: string }): boolean => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') return true;
      return /socket hang up/i.test(err.message);
    };

    const MAX_RETRIES = 1;
    const RETRY_BACKOFF_MS = 200;

    const attempt = (n: number): void => {
      const proxyReq = http.request(
        targetUrl,
        {
          method: req.method,
          headers: proxyHeaders,
          agent: proxyAgent,                    // no keep-alive: avoid stale sockets
          timeout: upstreamTimeoutMs,
        },
        (proxyRes) => {
          const contentType = proxyRes.headers['content-type'] ?? '';
          const isSSE = contentType.includes('text/event-stream');

          const responseHeaders: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (value && !['transfer-encoding', 'connection'].includes(key)) {
              responseHeaders[key] = value as string | string[];
            }
          }

          if (isSSE) {
            responseHeaders['cache-control'] = 'no-cache';
            responseHeaders['x-accel-buffering'] = 'no';
          }

          const origin = req.headers.origin;
          if (origin) {
            responseHeaders['access-control-allow-origin'] = origin;
            responseHeaders['access-control-allow-credentials'] = 'true';
          }

          res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);

          if (isSSE) {
            proxyRes.on('data', (chunk: Buffer) => {
              res.write(chunk);
              const flush = (res as Response & { flush?: () => void }).flush;
              if (typeof flush === 'function') flush.call(res);
            });
            proxyRes.on('end', () => res.end());
          } else {
            proxyRes.pipe(res);
          }
        }
      );

      proxyReq.setTimeout(upstreamTimeoutMs, () => {
        const err = new Error(
          `Container proxy timeout after ${upstreamTimeoutMs}ms`,
        ) as Error & { code?: string };
        err.code = 'ETIMEDOUT';
        proxyReq.destroy(err);
      });

      proxyReq.on('error', (err: Error & { code?: string }) => {
        if (
          n < MAX_RETRIES &&
          !res.headersSent &&
          canRetryBody &&
          isTransient(err)
        ) {
          console.warn(
            `[proxy] transient error for user ${auth.userId}, retry ${n + 1}/${MAX_RETRIES}: ${err.message}`,
          );
          setTimeout(() => attempt(n + 1), RETRY_BACKOFF_MS * (n + 1));
          return;
        }
        console.error(`[proxy] Request to container failed for user ${auth.userId}:`, err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Container proxy error', code: 'PROXY_ERROR' });
        } else {
          res.end();
        }
      });

      if (methodHasBody) {
        if (bufferedBody !== null) {
          proxyReq.setHeader('content-type', 'application/json');
          proxyReq.setHeader('content-length', Buffer.byteLength(bufferedBody));
          proxyReq.end(bufferedBody);
        } else {
          // Stream forwarding — no retry available. First attempt only.
          req.pipe(proxyReq);
        }
      } else {
        proxyReq.end();
      }
    };

    attempt(0);
  };
}
