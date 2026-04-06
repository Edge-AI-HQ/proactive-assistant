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

const PROFILE = 'proactive-ai';
const PROFILE_DIR = join(homedir(), `.openclaw-${PROFILE}`);
const AUTH_PROFILES_PATH = join(PROFILE_DIR, 'agents', 'main', 'agent', 'auth-profiles.json');

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
