/**
 * Proactive AI API routes.
 *
 * /proactive              -> SPA entry (static HTML)
 * /api/proactive/auth/me  -> Current user info
 * /api/proactive/user/*   -> User + container management
 * /api/proxy/*            -> Reverse proxy to user's container
 */

import { Router, type Application, type Response } from 'express';
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
  deleteBrowserContext,
} from '../domain/proactive/index.js';
import { pool } from '../domain/common/db/core.js';
import {
  registerDevice,
  listDevicesForUser,
  revokeDevice,
  rotateDeviceToken,
  type DevicePlatform,
} from '../domain/devices/index.js';
import {
  requestPairingCode,
  pollPairingCode,
  claimPairingCode,
  cancelPairingCode,
} from '../domain/devices/pairing.js';
import { isDomainError } from '../domain/common/errors.js';
import { getContainerRuntime } from '../domain/container/provider_factory.js';
import { relayGatewayWs } from '../domain/gateway/gateway_ws_relay.js';
import { getCurrentModel, setCurrentModel } from '../domain/gateway/gateway_rpc.js';
import { config } from '../domain/common/config.js';

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

// ── Device registry ──
// See docs/plans/memory-architecture.mdx §三 (APIs user_devices) and apis/db/migrations/002.
//
// POST /api/proactive/devices/register   { deviceId, platform, displayName?, appVersion?, metadata? }
// GET  /api/proactive/devices            list active devices for the current user
// POST /api/proactive/devices/revoke     { deviceId }
//
// On register/rotate, the response includes `device_token` PLAINTEXT — the
// client MUST store it (Capacitor Preferences / iOS Keychain / Android
// EncryptedSharedPreferences / web localStorage) and send X-Device-Token
// + X-Device-Id on every subsequent /api/mobile/* request.

router.post('/api/proactive/devices/register', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = String(body['deviceId'] ?? '').trim();
    const platform = String(body['platform'] ?? '').trim() as DevicePlatform;
    if (!deviceId || !platform) {
      res.status(400).json({ error: 'Missing deviceId or platform' });
      return;
    }
    const user = await getUserBySupabaseId(auth.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const device = await registerDevice({
      userId: user.id,
      deviceId,
      platform,
      displayName: typeof body['displayName'] === 'string' ? body['displayName'] : null,
      appVersion: typeof body['appVersion'] === 'string' ? body['appVersion'] : null,
      model: typeof body['model'] === 'string' ? body['model'] : null,
      metadata: body['metadata'] && typeof body['metadata'] === 'object'
        ? body['metadata'] as Record<string, unknown> : {},
    });
    res.json({
      ok: true,
      device: {
        device_id: device.device_id,
        platform: device.platform,
        model: device.model,
        display_name: device.display_name,
        registered_at: device.registered_at,
        status: device.status,
      },
      device_token: device.device_token,                 // ← returned ONCE
    });
  } catch (err) {
    console.error('[proactive] devices/register error:', err);
    if (err instanceof Error && (err as any).code === 'INVALID_INPUT') {
      res.status(400).json({ error: err.message }); return;
    }
    if (err instanceof Error && (err as any).code === 'CONFLICT') {
      res.status(409).json({ error: err.message }); return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/proactive/devices', requireProactiveAuth, async (req, res) => {
  try {
    const user = await getUserBySupabaseId(req.proactiveAuth!.userId);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const devices = await listDevicesForUser(user.id);
    res.json({ ok: true, devices });
  } catch (err) {
    console.error('[proactive] devices list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Pair Code (RFC 8628 simplified) ──
// Spec: docs/plans/2026-04-29-personal-signal-and-pairing.mdx §三 Class B.
//
// Device flow:
//   POST  /devices/pair-code/request  → { code, poll_url, poll_interval, expires_in }
//   GET   /devices/pair-code/poll?code=...  → { status, [device_id, device_token] when claimed }
//   POST  /devices/pair-code/cancel  { code }   (device or user gives up)
// User flow:
//   POST  /devices/pair-code/claim   { code, displayName?, model? }   (Supabase auth required)

const DOMAIN_ERROR_TO_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

function sendDomainError(res: Response, err: unknown, fallback: string): void {
  if (isDomainError(err)) {
    const status = DOMAIN_ERROR_TO_STATUS[err.code] ?? 500;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(fallback, err);
  res.status(500).json({ error: 'Internal server error' });
}

router.post('/api/proactive/devices/pair-code/request', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceClass = String(body['deviceClass'] ?? body['device_class'] ?? 'wearable').trim() as DevicePlatform;
    const model = typeof body['model'] === 'string' ? body['model'] : null;
    const result = await requestPairingCode({ deviceClass, model });
    res.json(result);
  } catch (err) {
    sendDomainError(res, err, '[proactive] pair-code/request error:');
  }
});

router.get('/api/proactive/devices/pair-code/poll', async (req, res) => {
  try {
    const code = String(req.query['code'] ?? '').trim();
    const result = await pollPairingCode(code);
    res.json(result);
  } catch (err) {
    sendDomainError(res, err, '[proactive] pair-code/poll error:');
  }
});

router.post('/api/proactive/devices/pair-code/claim', requireProactiveAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body['code'] ?? '').trim().toUpperCase();
    const user = await getUserBySupabaseId(req.proactiveAuth!.userId);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const result = await claimPairingCode({
      userId: user.id,
      code,
      displayName: typeof body['displayName'] === 'string' ? body['displayName'] : null,
      model: typeof body['model'] === 'string' ? body['model'] : null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    sendDomainError(res, err, '[proactive] pair-code/claim error:');
  }
});

router.post('/api/proactive/devices/pair-code/cancel', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body['code'] ?? '').trim();
    if (!code) { res.status(400).json({ error: 'code required' }); return; }
    await cancelPairingCode(code);
    res.json({ ok: true });
  } catch (err) {
    sendDomainError(res, err, '[proactive] pair-code/cancel error:');
  }
});

// Token rotation: device authenticates with its *current* PSK and gets a
// fresh one back. Old token stops working immediately. No user JWT needed
// — the current token is the credential. Devices should rotate on a
// 30-day cadence to bound exposure if a token leaks.
router.post('/api/proactive/devices/rotate-token', async (req, res) => {
  try {
    const deviceId = String(req.header('x-device-id') ?? '').trim();
    const currentToken = String(req.header('x-device-token') ?? '').trim();
    if (!deviceId || !currentToken) {
      res.status(400).json({ error: 'X-Device-Id and X-Device-Token required' });
      return;
    }
    const result = await rotateDeviceToken({ deviceId, currentToken });
    res.json({ ok: true, device_token: result.device_token });
  } catch (err) {
    sendDomainError(res, err, '[proactive] devices/rotate-token error:');
  }
});

router.post('/api/proactive/devices/revoke', requireProactiveAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = String(body['deviceId'] ?? '').trim();
    if (!deviceId) { res.status(400).json({ error: 'Missing deviceId' }); return; }
    const user = await getUserBySupabaseId(req.proactiveAuth!.userId);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const revoked = await revokeDevice({ userId: user.id, deviceId });
    if (!revoked) { res.status(404).json({ error: 'Device not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] devices/revoke error:', err);
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

// Clear the user's Browserbase context ("reset saved logins/cookies").
// Effect is DB-side immediate, but any running container still has the
// old context id in its env — the fresh empty context is used on the
// next container spawn. Callers that want instant effect should destroy
// the container too.
router.delete('/api/proactive/browser/context', requireProactiveAuth, async (req, res) => {
  try {
    await deleteBrowserContext(pool, req.proactiveAuth!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] browser/context delete error:', err);
    res.status(500).json({ error: 'Failed to reset browser context' });
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

// -- Model management --

router.get('/api/proactive/models', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const allowedModels = config.litellm.allowedModels.length
      ? config.litellm.allowedModels
      : [config.litellm.openclawDefaultModel];
    const defaultModel = config.litellm.openclawDefaultModel;

    let currentModel: string | null = null;
    const user = await getUserBySupabaseId(auth.userId);
    const container = await getContainerForUser(auth.userId);
    if (user?.gateway_token && container?.status === 'running') {
      const target = getOrchestrator().resolveTarget(container);
      if (target) {
        try {
          currentModel = await getCurrentModel(target, user.gateway_token);
        } catch {
          // Gateway unreachable — fall back to default below
        }
      }
    }

    res.json({
      ok: true,
      current_model: currentModel ?? `litellm/${defaultModel}`,
      default_model: `litellm/${defaultModel}`,
      available_models: allowedModels.map((id) => ({ id, ref: `litellm/${id}` })),
    });
  } catch (err) {
    console.error('[proactive] /models error:', err);
    res.status(500).json({ error: 'Failed to read models' });
  }
});

router.post('/api/proactive/models/change', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const body = req.body as { model?: unknown } | undefined;
    const modelRef = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!modelRef) {
      res.status(400).json({ error: 'model is required (e.g. litellm/claude-opus-4-6)' });
      return;
    }

    const bareId = modelRef.replace(/^litellm\//i, '');
    const allowedModels = config.litellm.allowedModels.length
      ? config.litellm.allowedModels
      : [config.litellm.openclawDefaultModel];
    if (!allowedModels.includes(bareId)) {
      res.status(400).json({ error: `Model "${bareId}" is not in the allowed list.`, allowed: allowedModels });
      return;
    }

    const normalizedRef = modelRef.startsWith('litellm/') ? modelRef : `litellm/${modelRef}`;

    const user = await getUserBySupabaseId(auth.userId);
    if (!user?.gateway_token) {
      res.status(500).json({ error: 'Gateway token missing.' });
      return;
    }

    const container = await getContainerForUser(auth.userId);
    if (!container || container.status !== 'running') {
      res.status(503).json({ error: 'Container not running. Please wait for it to start.' });
      return;
    }

    const target = getOrchestrator().resolveTarget(container);
    if (!target) {
      res.status(502).json({ error: 'Failed to resolve gateway target.' });
      return;
    }

    const result = await setCurrentModel(target, user.gateway_token, normalizedRef);
    if (!result.ok) {
      res.status(502).json({ error: `Gateway rejected model change: ${result.error}` });
      return;
    }

    res.json({ ok: true, model: normalizedRef });
  } catch (err) {
    console.error('[proactive] /models/change error:', err);
    res.status(500).json({ error: 'Failed to change model' });
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
  // Preferred device-ingest path. New clients should use this.
  // Pinned to /ingest so we don't shadow the device-management routes
  // declared above (/devices/register, /devices, /devices/revoke).
  router.post('/api/proactive/devices/ingest', async (req, res) => {
    const orchestrator = getOrchestrator();
    const proxy = createMobileProxy(orchestrator);
    await proxy(req, res);
  });
  // Legacy alias kept for old mobile clients (MOBILE_ITEMS_INGEST_PATH).
  // Same proxy + rewrite logic; will be removed once all clients cut over.
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
