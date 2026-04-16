import type { Request, Response } from 'express';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { ProactiveContainerOrchestrator } from './container_orchestrator.js';
import { getDefaultMobileSyncContainer } from './user_service.js';
import { config } from '../common/config.js';

export function isMobileProxyEnabled(): boolean {
  if (process.env.MOBILE_SYNC_PROXY_ENABLED?.trim() === '1') return true;
  const nodeEnv = (process.env.NODE_ENV ?? config.nodeEnv).trim().toLowerCase();
  return nodeEnv !== 'production';
}

export function rewriteMobileProxyPath(originalUrl: string): string {
  return originalUrl.replace(/^\/api\/mobile\/?/, '/proactive-ai/api/mobile/');
}

export function buildMobileProxyHeaders(
  requestHeaders: IncomingHttpHeaders,
  options: {
    gatewayToken: string;
    targetBaseUrl: string;
    hostOverride?: string | null;
  },
): Record<string, string> {
  const targetHost = options.hostOverride ?? new URL(options.targetBaseUrl).host;
  const proxyHeaders: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(requestHeaders).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>,
    Authorization: `Bearer ${options.gatewayToken}`,
    host: targetHost,
  };

  delete proxyHeaders['transfer-encoding'];
  delete proxyHeaders['connection'];
  delete proxyHeaders['authorization'];

  return proxyHeaders;
}

export function createMobileProxy(orchestrator: ProactiveContainerOrchestrator) {
  return async function mobileProxyHandler(req: Request, res: Response): Promise<void> {
    let container = await getDefaultMobileSyncContainer();
    if (!container) {
      res.status(503).json({
        error: 'No mobile sync target container is available',
        code: 'NO_MOBILE_TARGET',
      });
      return;
    }

    if (container.status !== 'running') {
      try {
        if (container.user_key) {
          await orchestrator.resumeContainer(container.user_key);
        }
      } catch (err) {
        console.error('[mobile-proxy] Failed to resume mobile sync target:', err);
      }
      const resumed = await getDefaultMobileSyncContainer();
      if (resumed) {
        container = resumed;
      }
      if (container.status !== 'running') {
        res.status(503).json({
          error: `Mobile sync target is ${container.status}`,
          code: 'TARGET_NOT_RUNNING',
          status: container.status,
        });
        return;
      }
    }

    const target = orchestrator.resolveTarget(container);
    if (!target) {
      res.status(503).json({ error: 'Cannot resolve mobile sync target', code: 'NO_TARGET' });
      return;
    }

    const proxyPath = rewriteMobileProxyPath(req.originalUrl);
    const targetUrl = new URL(proxyPath, target.httpBaseUrl);
    const proxyHeaders = buildMobileProxyHeaders(req.headers, {
      gatewayToken: container.gateway_token,
      targetBaseUrl: target.httpBaseUrl,
      ...(target.hostOverride ? { hostOverride: target.hostOverride } : {}),
    });

    const proxyReq = http.request(
      targetUrl,
      {
        method: req.method,
        headers: proxyHeaders,
        timeout: 60_000,
      },
      (proxyRes) => {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value && !['transfer-encoding', 'connection'].includes(key)) {
            responseHeaders[key] = value as string | string[];
          }
        }
        const origin = req.headers.origin;
        if (origin) {
          responseHeaders['access-control-allow-origin'] = origin;
          responseHeaders['access-control-allow-credentials'] = 'true';
        }

        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      console.error('[mobile-proxy] Request failed:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Mobile proxy error', code: 'PROXY_ERROR' });
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
