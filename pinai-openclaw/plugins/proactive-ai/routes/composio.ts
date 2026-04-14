import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const KEY_FILE = '/app/data/composio-api-key';

async function composioApi(apiKey: string, path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Composio API ${response.status}: ${data.message ?? data.error ?? text.slice(0, 200)}`);
  return data;
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
        json(ctx.res, 200, { connections: items.map((item: any) => ({
          toolkit: item.toolkit?.slug ?? item.toolkit ?? 'unknown',
          status: (item.status ?? 'NOT_CONNECTED').toUpperCase(),
          connectedAccountId: item.id ?? item.connected_account_id,
          userInfo: item.user_info ?? item.current_user_info ?? null,
        })) });
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

      if (route === '/wait') {
        const connectedAccountId = String(body['connectedAccountId'] ?? '').trim();
        if (!connectedAccountId) { json(ctx.res, 400, { error: 'Missing connectedAccountId' }); return true; }
        const startedAt = Date.now();
        while (Date.now() - startedAt < 120_000) {
          try {
            const account = await composioApi(apiKey, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
            if ((account.status ?? '').toUpperCase() === 'ACTIVE') {
              json(ctx.res, 200, { status: 'ACTIVE', connectedAccountId });
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
