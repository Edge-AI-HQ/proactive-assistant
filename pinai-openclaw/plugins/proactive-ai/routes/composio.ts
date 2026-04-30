import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';
import { isBackgroundAutoLoopTasksEnabled } from '../shared/background-auto-loop-tasks.js';

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const KEY_FILE = '/app/data/composio-api-key';
const IDENTITY_CACHE_FILE = '/app/data/composio-identity-cache.json';

interface IdentityCache {
  [connectedAccountId: string]: { userInfo: Record<string, unknown>; ts: number };
}

const IDENTITY_TTL = 24 * 60 * 60 * 1000; // 24h

function loadIdentityCache(): IdentityCache {
  try { return JSON.parse(readFileSync(IDENTITY_CACHE_FILE, 'utf-8')); } catch { return {}; }
}

function saveIdentityCache(cache: IdentityCache): void {
  try { mkdirSync(dirname(IDENTITY_CACHE_FILE), { recursive: true }); writeFileSync(IDENTITY_CACHE_FILE, JSON.stringify(cache)); } catch { /* ignore */ }
}

const COMPOSIO_V2_BASE = 'https://backend.composio.dev/api/v2';

const IDENTITY_ACTIONS: Record<string, string> = {
  gmail: 'GMAIL_GET_PROFILE',
  slack: 'SLACK_LIST_AUTH_IDENTITY',
  github: 'GITHUB_GET_THE_AUTHENTICATED_USER',
  linkedin: 'LINKEDIN_LINKEDIN_GET_CURRENT_USER_PROFILE',
};

async function fetchIdentityViaAction(
  apiKey: string,
  toolkit: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const actionId = IDENTITY_ACTIONS[toolkit];
  if (!actionId) return null;
  try {
    const res = await fetch(`${COMPOSIO_V2_BASE}/actions/${actionId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ appName: toolkit, entityId, input: {} }),
    });
    if (!res.ok) return null;
    const result = await res.json();
    const data = result?.data?.response_data ?? result?.data ?? null;
    if (data && typeof data === 'object' && Object.keys(data).length > 0) return data as Record<string, unknown>;
    return null;
  } catch { return null; }
}

async function composioApi(apiKey: string, path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Composio API ${response.status}: ${data.message ?? data.error ?? text.slice(0, 200)}`);
  return data;
}

/**
 * Enqueue a connector.init task on first ACTIVE detection. Returns null
 * (no task) when the scheduler is disabled, when toolkit is missing, or
 * when enqueue itself fails — /wait must not break for an init plumbing
 * issue. Idempotency on the task key means /wait can be re-fired safely.
 *
 * Phase B: gated by BACKGROUND_AUTO_LOOP_TASKS_ENABLED. It is on by
 * default; when explicitly disabled, /composio/wait keeps its old behavior
 * (no initTaskId field in response).
 *
 * Exported for tests; production callers go through /composio/wait.
 */
export async function maybeEnqueueConnectorInit(
  toolkit: string,
  connectedAccountId: string,
): Promise<string | null> {
  if (!isBackgroundAutoLoopTasksEnabled()) return null;
  if (!toolkit || !connectedAccountId) return null;
  const limit = Number(process.env.CONNECTOR_INIT_DEFAULT_LIMIT ?? 100);
  try {
    const result = await db.enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: `connector.init:${toolkit}:${connectedAccountId}:v1`,
      payload: { toolkit, connectedAccountId, limit, reason: 'composio_wait' },
      priority: 50,
      maxAttempts: 3,
    });
    return result.task.id;
  } catch {
    // Don't fail /wait — the reconciler will pick it up on the next sweep.
    return null;
  }
}

/**
 * Enqueue a fresh connector.init that bypasses the v1 idempotency key —
 * used by the debug "Reconnect" button. The new key includes a timestamp
 * so it never collides with the original v1 task or another reconnect.
 *
 * Raw rows / signals dedupe naturally via dedupe_key (most rows are the
 * same and get ignored on re-ingest); rows that are new since the last
 * pull land as fresh entries, and the evolve agent runs again on whatever
 * was inserted, giving the user a chance to surface fresh memory.
 *
 * No data is deleted. Caller is expected to be authenticated through the
 * gateway — same surface as /composio/wait.
 */
export async function enqueueReconnect(
  toolkit: string,
  connectedAccountId: string,
): Promise<string | null> {
  if (!isBackgroundAutoLoopTasksEnabled()) return null;
  if (!toolkit || !connectedAccountId) return null;
  const limit = Number(process.env.CONNECTOR_INIT_DEFAULT_LIMIT ?? 100);
  const ts = Date.now();
  try {
    const result = await db.enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: `connector.init:${toolkit}:${connectedAccountId}:reconnect:${ts}`,
      payload: { toolkit, connectedAccountId, limit, reason: 'reconnect' },
      priority: 40,  // slightly higher than reconciler-initiated (50) so user sees progress sooner
      maxAttempts: 3,
    });
    return result.task.id;
  } catch {
    return null;
  }
}

/** Read Composio API key: file takes priority over env var. */
function getComposioApiKey(): { key: string; source: 'user' | 'env' } | null {
  try {
    const fileKey = readFileSync(KEY_FILE, 'utf-8').trim();
    if (fileKey) return { key: fileKey, source: 'user' };
  } catch { /* file not found — fall through */ }
  const envKey = process.env.COMPOSIO_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };
  return null;
}

export function handleComposio(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/composio/')) return false;
    const route = ctx.subpath.slice('/composio'.length);
    const resolved = getComposioApiKey();
    const apiKey = resolved?.key;
    const userId = process.env.COMPOSIO_USER_ID?.trim() || process.env.PROACTIVE_USER_ID || 'default';

    try {
      if (route === '/status' && ctx.req.method === 'GET') {
        json(ctx.res, 200, resolved
          ? { configured: true, keyPrefix: resolved.key.slice(0, 6) + '...', source: resolved.source }
          : { configured: false });
        return true;
      }

      if (route === '/setup' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const newKey = String(body['key'] ?? '').trim();
        if (!newKey) { json(ctx.res, 400, { error: 'Missing key' }); return true; }
        // Validate the key by calling Composio API
        try {
          await composioApi(newKey, `/connected_accounts?limit=1`);
        } catch {
          json(ctx.res, 400, { error: 'Invalid API key — Composio rejected it' }); return true;
        }
        mkdirSync(dirname(KEY_FILE), { recursive: true });
        writeFileSync(KEY_FILE, newKey, { mode: 0o600 });
        json(ctx.res, 200, { ok: true, keyPrefix: newKey.slice(0, 6) + '...' });
        return true;
      }

      if (!apiKey) { json(ctx.res, 400, { error: 'COMPOSIO_API_KEY not configured' }); return true; }

      if (route === '/connections' && ctx.req.method === 'GET') {
        const data = await composioApi(apiKey, `/connected_accounts?user_ids=${userId}&statuses=ACTIVE&limit=100`);
        const items = Array.isArray(data.items) ? data.items : [];
        const cache = loadIdentityCache();
        let cacheUpdated = false;

        const connections = await Promise.all(items.map(async (item: any) => {
          const id = item.id ?? item.connected_account_id;
          const toolkit = (item.toolkit?.slug ?? item.toolkit ?? 'unknown') as string;
          let userInfo = item.user_info ?? item.current_user_info ?? null;

          if (!userInfo && id) {
            const cached = cache[id];
            if (cached && Date.now() - cached.ts < IDENTITY_TTL) {
              userInfo = cached.userInfo;
            } else {
              const identity = await fetchIdentityViaAction(apiKey, toolkit.toLowerCase(), userId);
              if (identity) {
                userInfo = identity;
                cache[id] = { userInfo: identity, ts: Date.now() };
                cacheUpdated = true;
              }
            }
          }

          return {
            toolkit,
            status: (item.status ?? 'NOT_CONNECTED').toUpperCase(),
            connectedAccountId: id,
            userInfo,
          };
        }));

        const activeIds = new Set(connections.map((c) => c.connectedAccountId));
        for (const key of Object.keys(cache)) {
          if (!activeIds.has(key)) { delete cache[key]; cacheUpdated = true; }
        }
        if (cacheUpdated) saveIdentityCache(cache);
        json(ctx.res, 200, { connections });
        return true;
      }

      if (ctx.req.method !== 'POST') return false;
      const body = await readBody(ctx.req);

      if (route === '/connect') {
        const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
        if (!toolkit) { json(ctx.res, 400, { error: 'Missing toolkit' }); return true; }
        const configList = await composioApi(apiKey, `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=20`);
        let authConfigId = (Array.isArray(configList.items) ? configList.items[0] : null)?.id;
        if (!authConfigId) {
          const created = await composioApi(apiKey, '/auth_configs', { method: 'POST', body: JSON.stringify({ toolkit: { slug: toolkit } }) });
          authConfigId = (created.auth_config as any)?.id ?? created.id;
        }
        if (!authConfigId) { json(ctx.res, 500, { error: `Failed to get auth config for ${toolkit}` }); return true; }
        const linked = await composioApi(apiKey, '/connected_accounts/link', {
          method: 'POST', body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
        });
        const connectedAccountId = linked.connected_account_id ?? linked.connectedAccountId ?? linked.id;
        const redirectUrl = linked.redirect_url ?? linked.redirectUrl;
        if (!connectedAccountId || !redirectUrl) {
          json(ctx.res, 500, { error: `Composio link response missing fields`, debug: { keys: Object.keys(linked) } });
          return true;
        }
        json(ctx.res, 200, { toolkit, status: 'PENDING', connectedAccountId, redirectUrl });
        return true;
      }

      if (route === '/disconnect') {
        const id = String(body['connectedAccountId'] ?? '').trim();
        if (!id) { json(ctx.res, 400, { error: 'Missing connectedAccountId' }); return true; }
        await composioApi(apiKey, `/connected_accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        json(ctx.res, 200, { ok: true });
        return true;
      }

      if (route === '/reconnect' && ctx.req.method === 'POST') {
        const connectedAccountId = String(body['connectedAccountId'] ?? '').trim();
        const toolkitParam = String(body['toolkit'] ?? '').trim().toLowerCase();
        if (!connectedAccountId) { json(ctx.res, 400, { error: 'Missing connectedAccountId' }); return true; }
        // Resolve toolkit if not provided: ask Composio. Lets the frontend
        // get away with sending only the accountId.
        let toolkit = toolkitParam;
        if (!toolkit) {
          try {
            const account = await composioApi(apiKey, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
            toolkit = String(account?.toolkit?.slug ?? account?.toolkit ?? '').trim().toLowerCase();
          } catch (err) {
            json(ctx.res, 404, { error: `Account not found: ${err instanceof Error ? err.message : String(err)}` });
            return true;
          }
        }
        if (!toolkit) { json(ctx.res, 400, { error: 'Could not resolve toolkit for account' }); return true; }
        const initTaskId = await enqueueReconnect(toolkit, connectedAccountId);
        if (!initTaskId) {
          json(ctx.res, 503, { error: 'Background scheduler disabled or enqueue failed' });
          return true;
        }
        json(ctx.res, 200, { ok: true, toolkit, connectedAccountId, initTaskId });
        return true;
      }

      if (route === '/wait') {
        const connectedAccountId = String(body['connectedAccountId'] ?? '').trim();
        if (!connectedAccountId) { json(ctx.res, 400, { error: 'Missing connectedAccountId' }); return true; }
        const startedAt = Date.now();
        while (Date.now() - startedAt < 120_000) {
          try {
            const account = await composioApi(apiKey, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
            if ((account.status ?? '').toUpperCase() === 'ACTIVE') {
              // On ACTIVE detection, enqueue connector.init for the toolkit.
              // The scheduler (when enabled) picks this up to backfill data.
              // Do NOT block /wait on the init task — return the task id and
              // let the frontend poll separately. Idempotency means this is
              // safe to call repeatedly across page reloads / multiple waits.
              const toolkit = String(
                account?.toolkit?.slug ?? account?.toolkit ?? body['toolkit'] ?? '',
              ).trim().toLowerCase();
              const initTaskId = await maybeEnqueueConnectorInit(toolkit, connectedAccountId);
              json(ctx.res, 200, { status: 'ACTIVE', connectedAccountId, ...(initTaskId ? { initTaskId } : {}) });
              return true;
            }
          } catch { /* account may not exist yet — keep polling */ }
          await new Promise(r => setTimeout(r, 2000));
        }
        json(ctx.res, 200, { status: 'TIMEOUT', connectedAccountId });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    return false;
  };
}
