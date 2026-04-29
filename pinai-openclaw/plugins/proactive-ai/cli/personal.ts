import { parseArgs, success, failure, readJsonFlag, readLimitFlag } from './shared.js';
import {
  resolveComposioApiKey,
  requireComposioApiKey,
  getComposioUserId,
} from '../shared/composio-key.js';

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const DEFAULT_TOOL_SEARCH_LIMIT = 20;
const MAX_TOOL_SEARCH_LIMIT = 50;
const READ_TOOL_VERBS = new Set(['FETCH', 'FIND', 'GET', 'LIST', 'LOOKUP', 'QUERY', 'READ', 'RETRIEVE', 'SEARCH']);
const SIDE_EFFECT_TOOL_VERBS = new Set([
  'ADD', 'ARCHIVE', 'CANCEL', 'CREATE', 'DELETE', 'DRAFT', 'EXECUTE', 'FORWARD',
  'INSERT', 'INVITE', 'MOVE', 'PATCH', 'POST', 'PUBLISH', 'REMOVE', 'REPLY',
  'RUN', 'SCHEDULE', 'SEND', 'SUBMIT', 'UPDATE', 'UPLOAD',
]);
const SIDE_EFFECT_TOOL_ALLOWLIST = new Set(['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_SEND_DRAFT']);

async function composioApi(apiKey: string, path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Composio API ${response.status}: ${formatComposioError(data, text)}`);
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
      'Use `pin signals list` / `pin signals recent` to read public PCI data.',
    );
  }

  if (sub === 'tools') {
    const action = positional[1];
    if (action === 'search') {
      const apiKey = getApiKey();
      const query = flags['query']?.trim() ?? flags['q']?.trim() ?? positional.slice(2).join(' ').trim();
      if (!query) return failure('personal', 'tools.search', 'validation', 'Missing --query');
      const limitRes = readLimitFlag(flags, 'personal', 'tools.search');
      if ('failure' in limitRes) return limitRes.failure;
      const limit = clampToolSearchLimit(limitRes.value);
      const toolkit = flags['toolkit']?.trim().toLowerCase();
      const params = new URLSearchParams({
        query,
        limit: String(limit),
        toolkit_versions: 'latest',
      });
      if (toolkit) params.set('toolkit_slug', toolkit);
      const data = await composioApi(apiKey, `/tools?${params}`);
      const tools = (Array.isArray(data.items) ? data.items : []).map(normalizeTool);
      return success('personal', 'tools.search', { query, toolkit: toolkit ?? null, count: tools.length, tools });
    }
    if (action === 'schema') {
      const apiKey = getApiKey();
      const slug = readToolSlug(flags, positional[2]);
      if (!slug) return failure('personal', 'tools.schema', 'validation', 'Missing --tool');
      const tool = await composioApi(apiKey, `/tools/${encodeURIComponent(slug)}?toolkit_versions=latest`);
      return success('personal', 'tools.schema', {
        tool: normalizeTool(tool),
        parameters: tool.input_parameters ?? tool.inputSchema ?? tool.parameters ?? {},
      });
    }
    return failure('personal', 'tools', 'validation', `Unknown tools action: ${action}`, 'Available: search, schema');
  }

  if (sub === 'exec') {
    const slug = readToolSlug(flags, positional[1]);
    if (!slug) return failure('personal', 'exec', 'validation', 'Missing --tool');
    const allowSideEffect = flags['allowSideEffect'] === 'true' || flags['allow-side-effect'] === 'true';
    const controlError = validateControlledExecTool(slug, { allowSideEffect });
    if (controlError) {
      return failure(
        'personal',
        'exec',
        'validation',
        controlError,
        'Public PCI exec allows read/query tools by default. Only allowlisted side effects can run, and they require `--allow-side-effect true` after inspecting `pin personal tools schema --tool <slug>`.',
      );
    }
    const inputRes = readJsonFlag<Record<string, unknown>>(flags, 'input', 'personal', 'exec');
    if ('failure' in inputRes) return inputRes.failure;
    const input = inputRes.value ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return failure('personal', 'exec', 'validation', '--input must be a JSON object');
    }
    const apiKey = getApiKey();
    const userId = getComposioUserId();
    const connectedAccountId = flags['connectedAccountId']?.trim() ?? flags['connected-account-id']?.trim();
    const result = await composioApi(apiKey, `/tools/execute/${encodeURIComponent(slug)}`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
        arguments: input,
      }),
    });
    return success('personal', 'exec', {
      tool: slug,
      connectedAccountId: connectedAccountId ?? null,
      sideEffectAllowed: allowSideEffect,
      result,
    });
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

  return failure('personal', sub ?? 'unknown', 'validation', `Unknown personal command: ${sub}`, 'Available: status, setup, connections, connect, wait, tools, exec');
}

function readToolSlug(flags: Record<string, string>, positionalFallback?: string): string | null {
  const raw = flags['tool'] ?? flags['name'] ?? flags['slug'] ?? positionalFallback;
  const slug = raw?.trim();
  if (!slug) return null;
  if (!/^[A-Za-z0-9_:-]+$/.test(slug)) return null;
  return slug;
}

function clampToolSearchLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOOL_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_TOOL_SEARCH_LIMIT, Math.floor(value)));
}

function normalizeTool(item: any): Record<string, unknown> {
  return {
    slug: item.slug ?? item.name ?? 'unknown',
    name: item.name ?? null,
    description: item.description ?? null,
    toolkit: item.toolkit?.slug ?? item.toolkit_slug ?? item.toolkit ?? null,
  };
}

function validateControlledExecTool(slug: string, opts: { allowSideEffect: boolean }): string | null {
  const normalizedSlug = slug.toUpperCase();
  const tokens = slug.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const sideEffectVerb = tokens.find((token) => SIDE_EFFECT_TOOL_VERBS.has(token));
  const allowedSideEffect = SIDE_EFFECT_TOOL_ALLOWLIST.has(normalizedSlug);
  if (allowedSideEffect) {
    if (!opts.allowSideEffect) {
      return `Tool ${slug} is a side-effect tool and requires --allow-side-effect true.`;
    }
    return null;
  }
  if (sideEffectVerb) {
    return `Tool ${slug} is not in the public PCI side effect allowlist (${sideEffectVerb.toLowerCase()}).`;
  }
  const hasReadVerb = tokens.some((token) => READ_TOOL_VERBS.has(token));
  if (!hasReadVerb) {
    return `Tool ${slug} is not allowed for public PCI exec because it is not clearly read/query-only.`;
  }
  return null;
}

function formatComposioError(data: Record<string, any>, text: string): string {
  const value = data.message ?? data.error;
  if (typeof value === 'string') return value;
  if (value !== undefined) {
    try { return JSON.stringify(value).slice(0, 400); } catch { /* fall through */ }
  }
  return text.slice(0, 200);
}
