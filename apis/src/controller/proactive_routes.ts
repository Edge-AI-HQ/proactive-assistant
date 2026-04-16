/**
 * Proactive AI API routes.
 *
 * /proactive              -> SPA entry (static HTML)
 * /api/proactive/auth/me  -> Current user info
 * /api/proactive/user/*   -> User + container management
 * /api/proxy/*            -> Reverse proxy to user's container
 */

import { Router, type Application } from 'express';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import {
  requireProactiveAuth,
  ProactiveContainerOrchestrator,
  createProactiveProxy,
  createMobileProxy,
  isMobileProxyEnabled,
  createGatewayProxy,
  createGatewayTicket,
  getSessionUserIdRaw,
  upsertUser,
  touchUserActivity,
  getContainerForUser,
  getUserBySupabaseId,
} from '../domain/proactive/index.js';
import { getContainerRuntime } from '../domain/container/provider_factory.js';
import { relayGatewayWs } from '../domain/gateway/gateway_ws_relay.js';

const router = Router();

// Lazily initialized orchestrator
let _orchestrator: ProactiveContainerOrchestrator | null = null;

function getOrchestrator(): ProactiveContainerOrchestrator {
  if (!_orchestrator) {
    const runtime = getContainerRuntime();
    _orchestrator = new ProactiveContainerOrchestrator(runtime);
  }
  return _orchestrator;
}

// -- CORS for API routes --
const CORS_PATHS = ['/api/proactive/*', '/api/proxy/*', '/api/gateway/*', '/api/mobile/*'];

router.use(CORS_PATHS, (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

router.options(CORS_PATHS, (_req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

// -- Auth routes --

router.get('/api/proactive/auth/me', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const user = await upsertUser({
      userId: auth.userId,
      email: auth.email,
      name: auth.name,
      avatarUrl: auth.avatarUrl,
    });
    const container = await getContainerForUser(auth.userId);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.display_name,
        avatar_url: user.avatar_url,
      },
      container: container ? {
        status: container.status,
        created_at: container.created_at,
      } : null,
    });
  } catch (err) {
    console.error('[proactive] /auth/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -- User / Container management --

router.post('/api/proactive/user/heartbeat', requireProactiveAuth, async (req, res) => {
  try {
    await touchUserActivity(req.proactiveAuth!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] heartbeat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/proactive/container/ensure', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;

    // Upsert user first
    await upsertUser({ userId: auth.userId, email: auth.email, name: auth.name, avatarUrl: auth.avatarUrl });

    const orchestrator = getOrchestrator();
    const result = await orchestrator.ensureContainer(auth.userId);
    const container = await getContainerForUser(auth.userId);

    res.json({
      containerId: result.containerId,
      ready: result.ready,
      status: container?.status ?? 'unknown',
    });
  } catch (err) {
    console.error('[proactive] container/ensure error:', err);
    res.status(500).json({ error: 'Failed to ensure container' });
  }
});

router.delete('/api/proactive/user/account', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    await orchestrator.deleteAccount(req.proactiveAuth!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.post('/api/proactive/container/reset', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    const result = await orchestrator.resetContainer(req.proactiveAuth!.userId);
    res.json({ ok: true, containerId: result.containerId, ready: result.ready });
  } catch (err) {
    console.error('[proactive] container/reset error:', err);
    res.status(500).json({ error: 'Failed to reset container' });
  }
});

router.post('/api/proactive/container/destroy', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    const destroyed = await orchestrator.destroyContainer(req.proactiveAuth!.userId);
    res.json({ ok: true, destroyed });
  } catch (err) {
    console.error('[proactive] container/destroy error:', err);
    res.status(500).json({ error: 'Failed to destroy container' });
  }
});

router.get('/api/proactive/container/status', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    const container = await orchestrator.reconcileContainer(req.proactiveAuth!.userId);
    if (!container) {
      res.json({ status: 'none' });
      return;
    }
    res.json({
      status: container.status,
      created_at: container.created_at,
    });
  } catch (err) {
    console.error('[proactive] container/status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -- Gateway ticket --

router.post('/api/proactive/gateway/ticket', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const container = await getContainerForUser(auth.userId);
    if (!container || container.status !== 'running') {
      res.status(503).json({ error: 'Container not running' });
      return;
    }
    const { ticket, expiresIn } = createGatewayTicket(auth.userId);
    res.json({ ticket, expiresIn, url: `/api/gateway/?ticket=${ticket}` });
  } catch (err) {
    console.error('[proactive] gateway/ticket error:', err);
    res.status(500).json({ error: 'Failed to create gateway ticket' });
  }
});

// -- Gateway UI proxy --

router.all('/api/gateway/*', async (req, res) => {
  const orchestrator = getOrchestrator();
  const proxy = createGatewayProxy(orchestrator);
  await proxy(req, res);
});

router.all('/api/gateway', async (req, res) => {
  const orchestrator = getOrchestrator();
  const proxy = createGatewayProxy(orchestrator);
  await proxy(req, res);
});

// -- Proxy routes --

router.all('/api/proxy/*', requireProactiveAuth, async (req, res) => {
  const orchestrator = getOrchestrator();
  const proxy = createProactiveProxy(orchestrator);
  await proxy(req, res);
});

if (isMobileProxyEnabled()) {
  router.all('/api/mobile/*', async (req, res) => {
    const orchestrator = getOrchestrator();
    const proxy = createMobileProxy(orchestrator);
    await proxy(req, res);
  });
}

// -- SPA entry point --

const spaEntryPath = path.join(process.cwd(), 'public', 'proactive', 'index.html');

router.get('/proactive', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(spaEntryPath, (err) => {
    if (err) {
      res.status(404).send('Proactive AI frontend not built yet. Run: npm run build --workspace @pin-ai/proactive-ai-frontend');
    }
  });
});

router.get('/proactive/*', (req, res) => {
  if (req.path.startsWith('/proactive/assets/')) return;
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(spaEntryPath, (err) => {
    if (err) {
      res.status(404).send('Proactive AI frontend not built yet.');
    }
  });
});

export function registerProactiveRoutes(app: Application): void {
  app.use(router);
}

// -- WebSocket upgrade for gateway relay --

function rejectUpgrade(socket: Socket, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  socket.destroy();
}

export function registerProactiveWsRoutes(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/gateway')) return;

    void (async () => {
      const userId = getSessionUserIdRaw(req);
      if (!userId) {
        rejectUpgrade(socket, '403 Forbidden');
        return;
      }

      // userId here is the Supabase UUID stored in the session cookie
      const user = await getUserBySupabaseId(userId);
      if (!user) {
        rejectUpgrade(socket, '503 Service Unavailable');
        return;
      }

      const orchestrator = getOrchestrator();
      const container = await orchestrator.reconcileContainer(userId);
      if (!container || container.status !== 'running') {
        rejectUpgrade(socket, '503 Service Unavailable');
        return;
      }

      const target = orchestrator.resolveTarget(container);
      if (!target) {
        rejectUpgrade(socket, '502 Bad Gateway');
        return;
      }

      req.url = '/';
      relayGatewayWs(req, socket, head, target, user.gateway_token);
    })().catch((err: unknown) => {
      console.error('[proactive] gateway WS upgrade error:', err);
      rejectUpgrade(socket, '500 Internal Server Error');
    });
  });
}
