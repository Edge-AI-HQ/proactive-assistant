import type { Request, Response } from 'express';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { ProactiveContainerOrchestrator } from './container_orchestrator.js';
import { getContainerByInternalId } from './user_service.js';
import type { ContainerWithToken } from './user_service.js';
import { findDeviceByToken } from '../devices/index.js';

// See container_proxy.ts for rationale — same SIGUSR1 reload concern.
const mobileProxyAgent = new http.Agent({ keepAlive: false });

export function isMobileProxyEnabled(): boolean {
  const override = process.env.MOBILE_SYNC_PROXY_ENABLED?.trim().toLowerCase();
  if (override === '0' || override === 'false' || override === 'off' || override === 'no') {
    return false;
  }
  return true;
}

/**
 * Path rewrite for the device-ingest proxy:
 *
 *   /api/proactive/devices/<rest>  →  /proactive-ai/api/devices/<rest>
 *
 * Only this single rewrite is supported. The legacy /api/mobile/* prefix
 * was retired once all clients (web SPA + Capacitor iOS/Android) cut over
 * to the explicit /api/proactive/devices/ingest path.
 */
export function rewriteMobileProxyPath(originalUrl: string): string {
  return originalUrl.replace(/^\/api\/proactive\/devices\/?/, '/proactive-ai/api/devices/');
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

/**
 * Resolve the user's container from a validated `(deviceId, deviceToken)`
 * pair. Returns null when the token doesn't match a registered device.
 * Caller is responsible for ensuring both inputs are non-empty.
 *
 * See docs/plans/memory-architecture.mdx §三 (APIs user_devices).
 */
async function findContainerByDeviceToken(
  deviceId: string,
  deviceToken: string,
): Promise<ContainerWithToken | null> {
  const device = await findDeviceByToken(deviceId, deviceToken);
  if (!device) return null;
  return getContainerByInternalId(device.user_id);
}

export function createMobileProxy(orchestrator: ProactiveContainerOrchestrator) {
  return async function mobileProxyHandler(req: Request, res: Response): Promise<void> {
    // Auth: every request MUST carry a valid X-Device-Id + X-Device-Token
    // pair. There is no anonymous fallback — the device-token check is the
    // only thing standing between the public ingest endpoint and another
    // user's data.
    const deviceId = String(req.header('x-device-id') ?? '').trim();
    const deviceToken = String(req.header('x-device-token') ?? '').trim();
    if (!deviceId || !deviceToken) {
      res.status(401).json({
        error: 'X-Device-Id and X-Device-Token headers are required',
        code: 'DEVICE_AUTH_REQUIRED',
      });
      return;
    }

    const container = await findContainerByDeviceToken(deviceId, deviceToken);
    if (!container) {
      res.status(401).json({
        error: 'Invalid device credentials',
        code: 'INVALID_DEVICE_TOKEN',
      });
      return;
    }

    // The proxy doesn't auto-resume suspended containers — when the
    // user's container isn't running we surface 503 and let the next
    // ingest retry land after the reconciler / chat-level resume path
    // has woken it up. That's the only place container lifecycle is
    // owned, and forcing the device-ingest path to drive resumes
    // would duplicate that responsibility here.
    if (container.status !== 'running') {
      res.status(503).json({
        error: `Mobile sync target is ${container.status}`,
        code: 'TARGET_NOT_RUNNING',
        status: container.status,
      });
      return;
    }

    const target = orchestrator.resolveTarget(container);
    if (!target) {
      res.status(503).json({ error: 'Cannot resolve mobile sync target', code: 'NO_TARGET' });
      return;
    }

    const proxyPath = rewriteMobileProxyPath(req.originalUrl);
    const targetUrl = new URL(proxyPath, target.httpBaseUrl);
    const proxyHeaders = buildMobileProxyHeaders(req.headers, {
      gatewayToken: container.container_proxy_secret,
      targetBaseUrl: target.httpBaseUrl,
      ...(target.hostOverride ? { hostOverride: target.hostOverride } : {}),
    });

    const proxyReq = http.request(
      targetUrl,
      {
        method: req.method,
        headers: proxyHeaders,
        agent: mobileProxyAgent,
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
