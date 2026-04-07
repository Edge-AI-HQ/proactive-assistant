import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ComposioConnection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  userInfo: Record<string, unknown> | null;
  redirectUrl: string | null;
}

interface ComposioRuntimeConfig {
  apiKey: string;
  apiBase: string;
  userId: string;
  callbackUrl: string | null;
  authConfigMap: Record<string, string>;
  source: 'platform-env' | 'platform-file';
}

const DEFAULT_COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

const asObj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const asStr = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function getComposioStatus(): {
  configured: boolean;
  mode: 'platform' | 'none';
  source: 'platform-env' | 'platform-file' | 'none';
  keyPrefix: string | null;
} {
  const config = loadComposioRuntimeConfig();
  if (!config) {
    return { configured: false, mode: 'none', source: 'none', keyPrefix: null };
  }

  return {
    configured: true,
    mode: 'platform',
    source: config.source,
    keyPrefix: `${config.apiKey.slice(0, 6)}...`,
  };
}

export async function listActiveConnections(): Promise<ComposioConnection[]> {
  const config = requireComposioRuntimeConfig();
  const items = await listConnectedAccounts(config, { statuses: ['ACTIVE'] });
  return items.map((row) => mapConnection(asStr(asObj(row.toolkit).slug) || 'unknown', row));
}

export async function connectToolkit(toolkit: string): Promise<ComposioConnection> {
  const config = requireComposioRuntimeConfig();
  const existing = await findLatestConnection(config, toolkit);
  if (existing && (asStr(existing.status) || '').toUpperCase() === 'ACTIVE') {
    return mapConnection(toolkit, existing);
  }

  const authConfigId = await ensureAuthConfigId(config, toolkit);
  const linked = await composioApi(config, '/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: config.userId,
      ...(config.callbackUrl ? { callback_url: config.callbackUrl } : {}),
    }),
  });

  return {
    toolkit,
    status: 'PENDING',
    connectedAccountId: asStr(linked.connected_account_id) || asStr(linked.connectedAccountId),
    userInfo: null,
    redirectUrl: asStr(linked.redirect_url) || asStr(linked.redirectUrl),
  };
}

export async function waitForToolkit(toolkit: string): Promise<ComposioConnection> {
  const config = requireComposioRuntimeConfig();
  const timeoutMs = 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const latest = await findLatestConnection(config, toolkit);
    const status = (asStr(latest?.status) || '').toUpperCase();
    if (latest && status === 'ACTIVE') {
      return mapConnection(toolkit, latest);
    }
    await sleep(2000);
  }

  const latest = await findLatestConnection(config, toolkit);
  return mapConnection(toolkit, latest);
}

function loadComposioRuntimeConfig(): ComposioRuntimeConfig | null {
  const envApiKey = process.env['COMPOSIO_API_KEY']?.trim();
  const homeDir = process.env['HOME'] ?? '/tmp';
  const settingsPath = resolve(homeDir, '.openclaw-proactive-ai', 'local-settings.json');

  let fileSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      fileSettings = asObj(JSON.parse(readFileSync(settingsPath, 'utf-8')));
    } catch {
      fileSettings = {};
    }
  }

  const composio = asObj(fileSettings.composio);
  const fileApiKey = asStr(composio.apiKey);
  const apiKey = envApiKey || fileApiKey;
  if (!apiKey) return null;

  const envMap = (() => {
    try {
      return JSON.parse(process.env['COMPOSIO_AUTH_CONFIG_MAP_JSON'] ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  })();
  const fileMapRaw = asObj(composio.authConfigMap);
  const fileMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileMapRaw)) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = asStr(value);
    if (normalizedKey && normalizedValue) {
      fileMap[normalizedKey] = normalizedValue;
    }
  }

  return {
    apiKey,
    apiBase: process.env['COMPOSIO_API_BASE'] || asStr(composio.apiBase) || DEFAULT_COMPOSIO_API_BASE,
    userId:
      process.env['COMPOSIO_USER_ID'] ||
      asStr(composio.userId) ||
      `pin_${createHash('sha256').update(homeDir).digest('hex').slice(0, 16)}`,
    callbackUrl: process.env['COMPOSIO_CALLBACK_URL'] || asStr(composio.callbackUrl),
    authConfigMap: { ...fileMap, ...envMap },
    source: envApiKey ? 'platform-env' : 'platform-file',
  };
}

function requireComposioRuntimeConfig(): ComposioRuntimeConfig {
  const config = loadComposioRuntimeConfig();
  if (!config) {
    throw new Error('Composio platform key is not configured');
  }
  return config;
}

async function composioApi(
  cfg: ComposioRuntimeConfig,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const parsed = text.trim() ? asObj(JSON.parse(text)) : {};
  if (!res.ok) {
    const msg = asStr(parsed.message) || asStr(parsed.error) || `Composio API ${res.status}`;
    throw new Error(msg);
  }
  return parsed;
}

function mapConnection(toolkit: string, row: Record<string, unknown> | null): ComposioConnection {
  return {
    toolkit: asStr(asObj(row?.toolkit).slug) || asStr(row?.toolkit) || toolkit,
    status: (asStr(row?.status) || 'NOT_CONNECTED').toUpperCase(),
    connectedAccountId: asStr(row?.id) || asStr(row?.connected_account_id) || asStr(row?.connectedAccountId),
    userInfo: row?.current_user_info ? asObj(row.current_user_info) : (row?.user_info ? asObj(row.user_info) : null),
    redirectUrl: asStr(row?.redirect_url) || asStr(row?.redirectUrl),
  };
}

async function listConnectedAccounts(
  cfg: ComposioRuntimeConfig,
  filters?: { toolkits?: string[]; statuses?: string[] },
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  params.set('user_ids', cfg.userId);
  params.set('limit', '100');
  if (filters?.toolkits?.length) params.set('toolkit_slugs', filters.toolkits.join(','));
  if (filters?.statuses?.length) params.set('statuses', filters.statuses.join(','));

  const response = await composioApi(cfg, `/connected_accounts?${params.toString()}`);
  return Array.isArray(response.items) ? response.items.map((item) => asObj(item)) : [];
}

async function findLatestConnection(
  cfg: ComposioRuntimeConfig,
  toolkit: string,
): Promise<Record<string, unknown> | null> {
  const items = await listConnectedAccounts(cfg, { toolkits: [toolkit] });
  if (!items.length) return null;

  return items.sort((left, right) => {
    const leftTs = asStr(left.updated_at) || asStr(left.created_at) || '';
    const rightTs = asStr(right.updated_at) || asStr(right.created_at) || '';
    return rightTs.localeCompare(leftTs);
  })[0] ?? null;
}

async function ensureAuthConfigId(cfg: ComposioRuntimeConfig, toolkit: string): Promise<string> {
  const mapped = cfg.authConfigMap[toolkit];
  if (mapped) return mapped;

  const listed = await composioApi(
    cfg,
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=20`,
  );
  const existing = Array.isArray(listed.items)
    ? listed.items.map((item) => asObj(item)).find((item) => asStr(item.id))
    : null;
  const existingId = asStr(existing?.id);
  if (existingId) return existingId;

  const created = await composioApi(cfg, '/auth_configs', {
    method: 'POST',
    body: JSON.stringify({
      toolkit: { slug: toolkit },
    }),
  });
  const createdId = asStr(asObj(created.auth_config).id) || asStr(created.id);
  if (!createdId) {
    throw new Error(`No auth config id returned for toolkit: ${toolkit}`);
  }
  return createdId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
