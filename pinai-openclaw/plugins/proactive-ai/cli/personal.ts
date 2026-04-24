import { readFileSync } from 'node:fs';
import { parseArgs, success, failure, readJsonFlag, readLimitFlag } from './shared.js';

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const DEFAULT_KEY_FILE = '/app/data/composio-api-key';

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

/** Read Composio API key: file takes priority over env var. */
export function resolveApiKey(): { key: string; source: 'user' | 'env' } | null {
  try {
    const fileKey = readFileSync(process.env.COMPOSIO_API_KEY_FILE ?? DEFAULT_KEY_FILE, 'utf-8').trim();
    if (fileKey) return { key: fileKey, source: 'user' };
  } catch { /* file not found — fall through */ }
  const envKey = process.env.COMPOSIO_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };
  return null;
}

function getApiKey(): string {
  const resolved = resolveApiKey();
  if (!resolved) throw new Error('COMPOSIO_API_KEY is not configured');
  return resolved.key;
}

function getComposioUserId(): string {
  return process.env.COMPOSIO_USER_ID?.trim() || process.env.PROACTIVE_USER_ID || 'default';
}

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

  if (sub === 'tools') {
    const action = positional[1];
    if (action === 'search') {
      const query = flags['query'];
      if (!query) return failure('personal', 'tools.search', 'validation', 'Missing --query');
      const limitRes = readLimitFlag(flags, 'personal', 'tools.search');
      if ('failure' in limitRes) return limitRes.failure;
      const apiKey = getApiKey();
      const params = new URLSearchParams({ query, limit: String(limitRes.value ?? 20), toolkit_versions: 'latest' });
      if (flags['toolkit']) params.set('toolkit_slug', flags['toolkit']);
      const data = await composioApi(apiKey, `/tools?${params}`);
      const items = Array.isArray(data.items) ? data.items : [];
      const tools = items.map((item: any) => ({ slug: item.slug ?? 'unknown', description: item.description ?? null, toolkit: item.toolkit?.slug ?? null }));
      return success('personal', 'tools.search', { query, count: tools.length, tools });
    }
    if (action === 'schema') {
      const name = flags['name'];
      if (!name) return failure('personal', 'tools.schema', 'validation', 'Missing --name');
      const apiKey = getApiKey();
      const tool = await composioApi(apiKey, `/tools/${encodeURIComponent(name)}?toolkit_versions=latest`);
      return success('personal', 'tools.schema', { slug: tool.slug ?? name, description: tool.description ?? null, parameters: tool.input_parameters ?? tool.inputSchema ?? {} });
    }
    return failure('personal', 'tools', 'validation', `Unknown tools action: ${action}`);
  }

  if (sub === 'exec') {
    const tool = flags['tool'];
    if (!tool) return failure('personal', 'exec', 'validation', 'Missing --tool');
    const inputRes = readJsonFlag<Record<string, unknown>>(flags, 'input', 'personal', 'exec');
    if ('failure' in inputRes) return inputRes.failure;
    const input = inputRes.value ?? {};
    const accountId = flags['account-id'];
    const apiKey = getApiKey();
    const userId = getComposioUserId();

    // If no account-id, find the latest active connection for the tool's toolkit
    let resolvedAccountId = accountId;
    if (!resolvedAccountId) {
      const toolDetails = await composioApi(apiKey, `/tools/${encodeURIComponent(tool)}?toolkit_versions=latest`);
      const toolkit = toolDetails.toolkit?.slug ?? (typeof toolDetails.toolkit === 'string' ? toolDetails.toolkit : null);
      if (toolkit) {
        const accounts = await composioApi(apiKey, `/connected_accounts?user_ids=${userId}&toolkit_slugs=${toolkit}&statuses=ACTIVE&limit=1`);
        const items = Array.isArray(accounts.items) ? accounts.items : [];
        resolvedAccountId = items[0]?.id ?? items[0]?.connected_account_id;
      }
    }

    const result = await composioApi(apiKey, `/tools/execute/${encodeURIComponent(tool)}`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        ...(resolvedAccountId ? { connected_account_id: resolvedAccountId } : {}),
        arguments: input,
      }),
    });
    return success('personal', 'exec', { tool, data: result });
  }

  return failure('personal', sub ?? 'unknown', 'validation', `Unknown personal command: ${sub}`, 'Available: status, setup, connections, connect, wait, tools, exec');
}
