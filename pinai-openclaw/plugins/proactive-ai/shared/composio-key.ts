/**
 * Single source of truth for Composio API key resolution.
 *
 * The user's per-container key is mounted as a file at /app/data/composio-api-key
 * (see apis-side ContainerProvider). Only legacy / dev environments fall back
 * to the COMPOSIO_API_KEY env var.
 *
 * Two callers historically diverged:
 *   - cli/personal.ts: file → env (correct)
 *   - dreaming/sources.ts: env only (wrong — never saw the user's key,
 *     so dream's `personal` source always reported "not configured")
 *
 * Use this helper everywhere instead.
 */
import { readFileSync } from 'node:fs';

const DEFAULT_KEY_FILE = '/app/data/composio-api-key';

export function resolveComposioApiKey(): { key: string; source: 'user' | 'env' } | null {
  try {
    const fileKey = readFileSync(process.env.COMPOSIO_API_KEY_FILE ?? DEFAULT_KEY_FILE, 'utf-8').trim();
    if (fileKey) return { key: fileKey, source: 'user' };
  } catch { /* file not found — fall through to env */ }
  const envKey = process.env.COMPOSIO_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };
  return null;
}

export function requireComposioApiKey(): string {
  const resolved = resolveComposioApiKey();
  if (!resolved) throw new Error('COMPOSIO_API_KEY is not configured');
  return resolved.key;
}

export function getComposioUserId(): string {
  return process.env.COMPOSIO_USER_ID?.trim() || process.env.PROACTIVE_USER_ID || 'default';
}
