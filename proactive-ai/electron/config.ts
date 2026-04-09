/**
 * OpenClaw profile configuration manager.
 *
 * Reads/writes files under ~/.openclaw-proactive-ai/ directly from the
 * Electron main process. This keeps all config management in Electron,
 * decoupled from the OpenClaw plugin.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const PROFILE_DIR = join(homedir(), '.openclaw-proactive-ai');
const AUTH_PROFILES_PATH = join(PROFILE_DIR, 'agents', 'main', 'agent', 'auth-profiles.json');
const LOCAL_SETTINGS_PATH = join(PROFILE_DIR, 'local-settings.json');

// ── Auth Profiles ──

interface AuthProfileStore {
  version: number;
  profiles: Record<string, { type: string; provider: string; key?: string; [k: string]: unknown }>;
  lastGood?: Record<string, string>;
  [k: string]: unknown;
}

function readAuthStore(): AuthProfileStore {
  if (!existsSync(AUTH_PROFILES_PATH)) {
    return { version: 1, profiles: {} };
  }
  try {
    return JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf-8'));
  } catch {
    return { version: 1, profiles: {} };
  }
}

function writeAuthStore(store: AuthProfileStore): void {
  mkdirSync(dirname(AUTH_PROFILES_PATH), { recursive: true });
  writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(store, null, 2) + '\n');
}

// ── Local settings file ──

interface LocalSettings {
  composio?: {
    apiKey?: string;
    apiBase?: string;
    userId?: string;
    callbackUrl?: string;
    authConfigMap?: Record<string, string>;
  };
  [k: string]: unknown;
}

function readLocalSettings(): LocalSettings {
  if (!existsSync(LOCAL_SETTINGS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(LOCAL_SETTINGS_PATH, 'utf-8')) as LocalSettings;
  } catch {
    return {};
  }
}

function writeLocalSettings(settings: LocalSettings): void {
  mkdirSync(dirname(LOCAL_SETTINGS_PATH), { recursive: true });
  writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

// ── Public API (called from IPC handlers) ──

export function getApiKeyStatus(): { configured: boolean; provider?: string; masked?: string } {
  const store = readAuthStore();
  const anthropic = store.profiles['anthropic:default'];
  if (anthropic?.key) {
    const k = anthropic.key;
    return {
      configured: true,
      provider: 'anthropic',
      masked: k.slice(0, 12) + '...' + k.slice(-4),
    };
  }
  return { configured: false };
}

export function saveApiKey(provider: string, key: string): { saved: boolean; error?: string; masked?: string } {
  if (provider !== 'anthropic') {
    return { saved: false, error: `Unsupported provider: ${provider}` };
  }
  if (!key.startsWith('sk-ant-')) {
    return { saved: false, error: 'Invalid key format (expected sk-ant-...)' };
  }

  const store = readAuthStore();
  store.profiles['anthropic:default'] = {
    type: 'api_key',
    provider: 'anthropic',
    key,
  };
  if (!store.lastGood) store.lastGood = {};
  store.lastGood['anthropic'] = 'anthropic:default';

  writeAuthStore(store);

  const masked = key.slice(0, 12) + '...' + key.slice(-4);
  return { saved: true, masked };
}

export function hasApiKey(): boolean {
  return getApiKeyStatus().configured;
}

export function getGatewayEnvFromLocalSettings(): Record<string, string> {
  const settings = readLocalSettings();
  const composio = settings.composio;
  if (!composio || typeof composio !== 'object') {
    return {};
  }

  const env: Record<string, string> = {};
  if (typeof composio.apiKey === 'string' && composio.apiKey.trim()) {
    env.COMPOSIO_API_KEY = composio.apiKey.trim();
  }
  if (typeof composio.apiBase === 'string' && composio.apiBase.trim()) {
    env.COMPOSIO_API_BASE = composio.apiBase.trim();
  }
  if (typeof composio.userId === 'string' && composio.userId.trim()) {
    env.COMPOSIO_USER_ID = composio.userId.trim();
  }
  if (typeof composio.callbackUrl === 'string' && composio.callbackUrl.trim()) {
    env.COMPOSIO_CALLBACK_URL = composio.callbackUrl.trim();
  }
  if (composio.authConfigMap && typeof composio.authConfigMap === 'object') {
    env.COMPOSIO_AUTH_CONFIG_MAP_JSON = JSON.stringify(composio.authConfigMap);
  }
  return env;
}

export function saveComposioApiKey(key: string): { saved: boolean; error?: string } {
  const nextKey = key.trim();
  if (!nextKey) {
    return { saved: false, error: 'Composio API key is empty' };
  }
  if (!nextKey.startsWith('ak_')) {
    return { saved: false, error: 'Composio API key must start with ak_' };
  }

  const settings = readLocalSettings();
  const composio = (settings.composio && typeof settings.composio === 'object')
    ? settings.composio as Record<string, unknown>
    : {};

  settings.composio = {
    ...composio,
    apiKey: nextKey,
  };
  writeLocalSettings(settings);
  return { saved: true };
}
