/**
 * Proactive AI API routes.
 *
 * /proactive              -> SPA entry (static HTML)
 * /api/proactive/user/*   -> User + container management
 * /api/proxy/*            -> Reverse proxy to user's container
 *
 * Auth: requireProactiveAuth verifies the Supabase JWT and upserts the local
 * users row, exposing it as `req.proactiveAuth.user`. Handlers should use that
 * directly instead of re-querying by Supabase id.
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
  getContainerForUser,
  getUserBySupabaseId,
  deleteBrowserContext,
} from '../domain/proactive/index.js';
import { sendDomainError, sendError } from './http_error.js';
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
import { createRateLimit } from '../domain/common/rate_limit.js';
import { chatHandler, chatInitHandler, generateHandler } from '../domain/proactive/agents_proxy.js';
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
const CORS_PATHS = ['/api/proactive/*', '/api/proxy/*', '/api/gateway/*'];

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

// -- User / Container management --

// requireProactiveAuth already refreshes last_active_at via upsertUser, so the
// handler just needs to acknowledge the call.
router.post('/api/proactive/user/heartbeat', requireProactiveAuth, (_req, res) => {
  res.json({ ok: true });
});

// ── Rate limiters for device endpoints ──
//
// Per-IP for unauthenticated endpoints (pair-code request/poll/cancel,
// register), per-device-id for authenticated ingest. Numbers picked to
// be comfortable for normal traffic (a phone batching every minute, a
// device polling every 3s during pairing) but to make brute force /
// runaway scripts visibly fail.
//
// In-memory + per-process: behind a single Fly machine today; revisit
// when we replicate. Defined here (above the routes that reference them)
// so all router.post() calls can pin the middleware in one place.

const ipKey = (req: { ip?: string | undefined; header(name: string): string | undefined }) =>
  req.header('x-forwarded-for')?.split(',')[0]?.trim() || req.ip || 'unknown-ip';

const ingestLimit = createRateLimit({
  name: 'devices/ingest',
  keyFn: (req) => req.header('x-device-id') ?? ipKey(req),
  capacity: 60, refillPerSec: 1,        // ≤60 ingest calls per minute per device
});

const registerLimit = createRateLimit({
  name: 'devices/register',
  keyFn: ipKey,
  capacity: 10, refillPerSec: 10 / 60,   // ≤10 per minute per IP
});

const pairCodeRequestLimit = createRateLimit({
  name: 'pair-code/request',
  keyFn: ipKey,
  capacity: 5, refillPerSec: 5 / 60,     // ≤5 per minute per IP
});

const pairCodePollLimit = createRateLimit({
  name: 'pair-code/poll',
  keyFn: ipKey,
  capacity: 30, refillPerSec: 30 / 60,   // ≤30 per minute per IP
});

const pairCodeClaimLimit = createRateLimit({
  name: 'pair-code/claim',
  keyFn: ipKey,
  capacity: 10, refillPerSec: 10 / 60,
});

// ── Device registry ──
// See docs/plans/memory-architecture.mdx §三 (APIs user_devices) and apis/db/migrations/002.
//
// POST /api/proactive/devices/register   { deviceId, platform, displayName?, appVersion?, deviceFingerprint?, metadata? }
// GET  /api/proactive/devices            list active devices for the current user
// POST /api/proactive/devices/revoke     { deviceId }
//
// On register/rotate, the response includes `device_token` PLAINTEXT — the
// client MUST store it securely (native secure storage / web localStorage) and
// send X-Device-Token + X-Device-Id on every subsequent
// /api/proactive/devices/ingest request. Native clients may also send an
// app-scoped secure-storage UUID as deviceFingerprint for same-device dedupe.

router.post('/api/proactive/devices/register', registerLimit, requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = String(body['deviceId'] ?? '').trim();
    const platform = String(body['platform'] ?? '').trim() as DevicePlatform;
    const deviceFingerprint = typeof body['deviceFingerprint'] === 'string'
      ? body['deviceFingerprint']
      : null;
    if (!deviceId || !platform) {
      sendDomainError(res, 'INVALID_INPUT', 'Missing deviceId or platform');
      return;
    }
    const device = await registerDevice({
      userId: auth.user.id,
      deviceId,
      platform,
      displayName: typeof body['displayName'] === 'string' ? body['displayName'] : null,
      appVersion: typeof body['appVersion'] === 'string' ? body['appVersion'] : null,
      model: typeof body['model'] === 'string' ? body['model'] : null,
      deviceFingerprint,
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
    sendError(res, err);
  }
});

router.get('/api/proactive/devices', requireProactiveAuth, async (req, res) => {
  try {
    const devices = await listDevicesForUser(req.proactiveAuth!.user.id);
    res.json({ ok: true, devices });
  } catch (err) {
    console.error('[proactive] devices list error:', err);
    sendError(res, err);
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

function sendDeviceFlowError(res: Response, err: unknown, fallback: string): void {
  if (isDomainError(err)) {
    const status = DOMAIN_ERROR_TO_STATUS[err.code] ?? 500;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(fallback, err);
  res.status(500).json({ error: 'Internal server error' });
}

router.post('/api/proactive/devices/pair-code/request', pairCodeRequestLimit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceClass = String(body['deviceClass'] ?? body['device_class'] ?? 'wearable').trim() as DevicePlatform;
    const model = typeof body['model'] === 'string' ? body['model'] : null;
    const result = await requestPairingCode({ deviceClass, model });
    res.json(result);
  } catch (err) {
    sendDeviceFlowError(res, err, '[proactive] pair-code/request error:');
  }
});

router.get('/api/proactive/devices/pair-code/poll', pairCodePollLimit, async (req, res) => {
  try {
    const code = String(req.query['code'] ?? '').trim();
    const result = await pollPairingCode(code);
    res.json(result);
  } catch (err) {
    sendDeviceFlowError(res, err, '[proactive] pair-code/poll error:');
  }
});

router.post('/api/proactive/devices/pair-code/claim', pairCodeClaimLimit, requireProactiveAuth, async (req, res) => {
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
    sendDeviceFlowError(res, err, '[proactive] pair-code/claim error:');
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
    sendDeviceFlowError(res, err, '[proactive] pair-code/cancel error:');
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
    sendDeviceFlowError(res, err, '[proactive] devices/rotate-token error:');
  }
});

router.post('/api/proactive/devices/revoke', requireProactiveAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = String(body['deviceId'] ?? '').trim();
    if (!deviceId) {
      sendDomainError(res, 'INVALID_INPUT', 'Missing deviceId');
      return;
    }
    const revoked = await revokeDevice({ userId: req.proactiveAuth!.user.id, deviceId });
    if (!revoked) {
      sendDomainError(res, 'NOT_FOUND', 'Device not found');
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] devices/revoke error:', err);
    sendError(res, err);
  }
});

router.post('/api/proactive/container/ensure', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
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
    sendError(res, err, 'Failed to ensure container');
  }
});

router.post('/api/proactive/user/delete', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    await orchestrator.deleteAccount(req.proactiveAuth!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] user/delete error:', err);
    sendError(res, err, 'Failed to delete account');
  }
});

router.post('/api/proactive/container/reset', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    const result = await orchestrator.resetContainer(req.proactiveAuth!.userId);
    res.json({ ok: true, containerId: result.containerId, ready: result.ready });
  } catch (err) {
    console.error('[proactive] container/reset error:', err);
    sendError(res, err, 'Failed to reset container');
  }
});

// Clear the user's Browserbase context ("reset saved logins/cookies").
// Effect is DB-side immediate, but any running container still has the
// old context id in its env — the fresh empty context is used on the
// next container spawn. Callers that want instant effect should destroy
// the container too.
router.post('/api/proactive/browser/context/reset', requireProactiveAuth, async (req, res) => {
  try {
    await deleteBrowserContext(pool, req.proactiveAuth!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proactive] browser/context/reset error:', err);
    sendError(res, err, 'Failed to reset browser context');
  }
});

router.post('/api/proactive/container/destroy', requireProactiveAuth, async (req, res) => {
  try {
    const orchestrator = getOrchestrator();
    const destroyed = await orchestrator.destroyContainer(req.proactiveAuth!.userId);
    res.json({ ok: true, destroyed });
  } catch (err) {
    console.error('[proactive] container/destroy error:', err);
    sendError(res, err, 'Failed to destroy container');
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
    sendError(res, err);
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
    const container = await getContainerForUser(auth.userId);
    if (container?.status === 'running') {
      const target = getOrchestrator().resolveTarget(container);
      if (target) {
        try {
          currentModel = await getCurrentModel(target, auth.user.container_proxy_secret);
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
    sendError(res, err, 'Failed to read models');
  }
});

router.post('/api/proactive/models/change', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const body = req.body as { model?: unknown } | undefined;
    const modelRef = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!modelRef) {
      sendDomainError(res, 'INVALID_INPUT', 'model is required (e.g. litellm/claude-opus-4-6)');
      return;
    }

    const bareId = modelRef.replace(/^litellm\//i, '');
    const allowedModels = config.litellm.allowedModels.length
      ? config.litellm.allowedModels
      : [config.litellm.openclawDefaultModel];
    if (!allowedModels.includes(bareId)) {
      sendDomainError(res, 'INVALID_INPUT', `Model "${bareId}" is not in the allowed list.`);
      return;
    }

    const normalizedRef = modelRef.startsWith('litellm/') ? modelRef : `litellm/${modelRef}`;

    const container = await getContainerForUser(auth.userId);
    if (!container || container.status !== 'running') {
      sendDomainError(res, 'UNAVAILABLE', 'Container not running. Please wait for it to start.');
      return;
    }

    const target = getOrchestrator().resolveTarget(container);
    if (!target) {
      sendDomainError(res, 'UNAVAILABLE', 'Failed to resolve gateway target.', 502);
      return;
    }

    const result = await setCurrentModel(target, auth.user.container_proxy_secret, normalizedRef);
    if (!result.ok) {
      sendDomainError(res, 'UNAVAILABLE', `Gateway rejected model change: ${result.error}`, 502);
      return;
    }

    res.json({ ok: true, model: normalizedRef });
  } catch (err) {
    console.error('[proactive] /models/change error:', err);
    sendError(res, err, 'Failed to change model');
  }
});

// -- Gateway ticket --

router.post('/api/proactive/gateway/ticket', requireProactiveAuth, async (req, res) => {
  try {
    const auth = req.proactiveAuth!;
    const container = await getContainerForUser(auth.userId);
    if (!container || container.status !== 'running') {
      sendDomainError(res, 'UNAVAILABLE', 'Container not running');
      return;
    }
    const { ticket, expiresIn } = createGatewayTicket(auth.userId);
    res.json({ ticket, expiresIn, url: `/api/gateway/?ticket=${ticket}` });
  } catch (err) {
    console.error('[proactive] gateway/ticket error:', err);
    sendError(res, err, 'Failed to create gateway ticket');
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

// Step 1.7: forward agent flows (generate / chat) to the pinai-agents
// Python service instead of the user's OpenClaw container. Order matters —
// these specific routes must register BEFORE the catch-all `/api/proxy/*`
// below, otherwise the catch-all's container proxy claims them first.
// See docs/plans/2026-05-04-step1-deepagents-skeleton.mdx.
router.post('/api/proxy/generate', requireProactiveAuth, async (req, res) => {
  await generateHandler(req, res);
});
router.post('/api/proxy/chat-stream/send', requireProactiveAuth, async (req, res) => {
  await chatHandler(req, res);
});
router.post('/api/proxy/chat-stream/init', requireProactiveAuth, async (req, res) => {
  await chatInitHandler(req, res);
});

router.all('/api/proxy/*', requireProactiveAuth, async (req, res) => {
  const orchestrator = getOrchestrator();
  const proxy = createProactiveProxy(orchestrator);
  await proxy(req, res);
});

if (isMobileProxyEnabled()) {
  // Device-ingest path. Auth is per-device (X-Device-Id + X-Device-Token
  // validated inside the proxy), not Supabase JWT — the request comes from
  // the registered mobile client, not from a logged-in browser session.
  // Pinned to /ingest so we don't shadow the device-management routes
  // declared above (/devices/register, /devices, /devices/revoke).
  // Rate limited per device_id (falls back to per-IP when no header).
  router.post('/api/proactive/devices/ingest', ingestLimit, async (req, res) => {
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
      relayGatewayWs(req, socket, head, target, user.container_proxy_secret);
    })().catch((err: unknown) => {
      console.error('[proactive] gateway WS upgrade error:', err);
      rejectUpgrade(socket, '500 Internal Server Error');
    });
  });
}
