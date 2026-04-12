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
import { getContainerForUser, touchUserActivity } from './user_service.js';

export function createProactiveProxy(orchestrator: ProactiveContainerOrchestrator) {
  return async function proxyHandler(req: Request, res: Response): Promise<void> {
    const auth = req.proactiveAuth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Touch activity for idle suspend tracking
    void touchUserActivity(auth.userId).catch(() => {});

    // Reconcile DB with runtime before trusting container state
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
    const proxyPath = req.originalUrl.replace(/^\/api\/proxy\/?/, '/proactive-ai/api/');

    // Proxy the request
    const targetUrl = new URL(proxyPath, target.httpBaseUrl);

    const proxyHeaders: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>,
      Authorization: `Bearer ${container.gateway_token}`,
      host: target.hostOverride ?? new URL(target.httpBaseUrl).host,
    };

    // Remove hop-by-hop headers
    delete proxyHeaders['transfer-encoding'];
    delete proxyHeaders['connection'];

    if (target.hostOverride) {
      proxyHeaders['origin'] = `http://${target.hostOverride}`;
    }

    const proxyReq = http.request(
      targetUrl,
      {
        method: req.method,
        headers: proxyHeaders,
        timeout: 600_000, // 10 minutes for long pipeline runs
      },
      (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] ?? '';
        const isSSE = contentType.includes('text/event-stream');

        // Set response headers
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value && !['transfer-encoding', 'connection'].includes(key)) {
            responseHeaders[key] = value as string | string[];
          }
        }

        // SSE: disable buffering
        if (isSSE) {
          responseHeaders['cache-control'] = 'no-cache';
          responseHeaders['x-accel-buffering'] = 'no';
        }

        // CORS headers
        const origin = req.headers.origin;
        if (origin) {
          responseHeaders['access-control-allow-origin'] = origin;
          responseHeaders['access-control-allow-credentials'] = 'true';
        }

        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);

        // Stream response
        if (isSSE) {
          // Flush immediately for SSE
          proxyRes.on('data', (chunk: Buffer) => {
            res.write(chunk);
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          });
          proxyRes.on('end', () => res.end());
        } else {
          proxyRes.pipe(res);
        }
      }
    );

    proxyReq.on('error', (err) => {
      console.error(`[proxy] Request to container failed for user ${auth.userId}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Container proxy error', code: 'PROXY_ERROR' });
      } else {
        res.end();
      }
    });

    // Forward request body
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
