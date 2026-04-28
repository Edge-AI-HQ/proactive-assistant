import { parseArgs, success, failure } from './shared.js';
import {
  resolveComposioApiKey,
  requireComposioApiKey,
  getComposioUserId,
} from '../shared/composio-key.js';

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

async function composioApi(apiKey: string, path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Composio API ${response.status}: ${data.message ?? data.error ?? text.slice(0, 200)}`);
  return data;
}

// Re-exported so existing callers (cli/sys.ts) keep working without churn.
// New code should import from shared/composio-key.ts directly.
export const resolveApiKey = resolveComposioApiKey;
const getApiKey = requireComposioApiKey;

export async function handlePersonal(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  // `personal mobile` was the v2 entry point reading the retired
  // mobile_items.db sink. In v3 mobile items live in personal_signals —
  // redirect callers rather than silently ignoring them.
  if (sub === 'mobile') {
    return failure(
      'personal',
      'mobile',
      'removed',
      'pin personal mobile is retired in v3',
      'Use `pin signals list` / `pin signals recent` to read; `pin signals consume --id <id> --runId <run>` to mark processed.',
    );
  }

  if (sub === 'tools' || sub === 'exec') {
    return failure(
      'personal',
      sub,
      'removed',
      '`pin personal tools` and `pin personal exec` are disabled in v3',
      'Use connector.init / connector.sync to ingest Composio data, then read with `pin raw ...`, `pin signals ...`, `pin memory ...`, and `pin profile get`.',
    );
  }

  if (sub === 'status') {
    const resolved = resolveApiKey();
    return success('personal', 'status', {
      configured: !!resolved,
      mode: resolved ? 'platform' : 'none',
      source: resolved?.source ?? 'none',
      keyPrefix: resolved ? resolved.key.slice(0, 6) + '...' : null,
    });
  }

  if (sub === 'setup') {
    const key = flags['key']?.trim();
    if (!key || !key.startsWith('ak_')) return failure('personal', 'setup', 'validation', "API key must start with 'ak_'");
    try {
      await composioApi(key, `/connected_accounts?user_ids=${getComposioUserId()}&limit=1`);
    } catch { return failure('personal', 'setup', 'provider_unavailable', 'API key validation failed'); }
    return success('personal', 'setup', { validated: true, keyPrefix: key.slice(0, 6) + '...' });
  }

  if (sub === 'connections') {
    const action = positional[1];
    if (action === 'list') {
      const apiKey = getApiKey();
      const userId = getComposioUserId();
      const toolkits = flags['toolkits'];
      const params = new URLSearchParams({ user_ids: userId, statuses: 'ACTIVE', limit: '100' });
      if (toolkits) params.set('toolkit_slugs', toolkits);
      const data = await composioApi(apiKey, `/connected_accounts?${params}`);
      const items = Array.isArray(data.items) ? data.items : [];
      const connections = items.map((item: any) => ({
        toolkit: item.toolkit?.slug ?? item.toolkit ?? 'unknown',
        status: (item.status ?? 'NOT_CONNECTED').toUpperCase(),
        connectedAccountId: item.id ?? item.connected_account_id,
        userInfo: item.user_info ?? item.current_user_info ?? null,
      }));
      return success('personal', 'connections.list', { connections });
    }
    return failure('personal', 'connections', 'validation', `Unknown connections action: ${action}`);
  }

  if (sub === 'connect') {
    const apiKey = getApiKey();
    const userId = getComposioUserId();
    const toolkit = flags['toolkit']?.trim().toLowerCase();
    if (!toolkit) return failure('personal', 'connect', 'validation', 'Missing --toolkit');

    // Find or create auth config
    const configList = await composioApi(apiKey, `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=20`);
    const items = Array.isArray(configList.items) ? configList.items : [];
    let authConfigId = items[0]?.id;
    if (!authConfigId) {
      const created = await composioApi(apiKey, '/auth_configs', { method: 'POST', body: JSON.stringify({ toolkit: { slug: toolkit } }) });
      authConfigId = created.auth_config?.id ?? created.id;
    }
    if (!authConfigId) return failure('personal', 'connect', 'internal', `Failed to get auth config for ${toolkit}`);

    const linked = await composioApi(apiKey, '/connected_accounts/link', {
      method: 'POST',
      body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
    });
    return success('personal', 'connect', {
      toolkit, status: 'PENDING',
      connectedAccountId: linked.connected_account_id ?? linked.connectedAccountId,
      redirectUrl: linked.redirect_url ?? linked.redirectUrl,
    });
  }

  if (sub === 'wait') {
    const apiKey = getApiKey();
    const userId = getComposioUserId();
    const toolkit = flags['toolkit']?.trim().toLowerCase();
    if (!toolkit) return failure('personal', 'wait', 'validation', 'Missing --toolkit');
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
      const data = await composioApi(apiKey, `/connected_accounts?user_ids=${userId}&toolkit_slugs=${toolkit}&limit=5`);
      const items = Array.isArray(data.items) ? data.items : [];
      const active = items.find((item: any) => (item.status ?? '').toUpperCase() === 'ACTIVE');
      if (active) return success('personal', 'wait', { toolkit, status: 'ACTIVE', connectedAccountId: active.id });
      await new Promise(r => setTimeout(r, 2000));
    }
    return success('personal', 'wait', { toolkit, status: 'TIMEOUT' });
  }

  return failure('personal', sub ?? 'unknown', 'validation', `Unknown personal command: ${sub}`, 'Available: status, setup, connections, connect, wait');
}
