/**
 * Per-user Browserbase context provisioning.
 *
 * A Browserbase "context" is a durable cookie/storage profile that survives
 * across sessions. We bind one to each Supabase user so the AI agent's
 * browser stays logged in to Gmail / calendar / shopping / etc. between
 * runs instead of starting fresh every time.
 *
 * Flow on container spawn:
 *   orchestrator → getOrCreateBrowserContext(userId)
 *   └── SELECT from proactive_browser_context
 *       ├── hit → return context_id
 *       └── miss → POST /v1/contexts on Browserbase → INSERT → return
 *   → env BROWSERBASE_CONTEXT_ID=<id> injected into container
 *
 * Inside the container, BrowserbaseManager.createSession reads the env
 * and passes `browserSettings.context = { id, persist: true }` so the
 * Browserbase session boots from that profile and any new cookies/
 * localStorage writes are persisted back into it on session close.
 */
import type { Queryable } from '../common/db/core.js';
import { DomainError } from '../common/errors.js';

const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1';
const CREATE_CONTEXT_TIMEOUT_MS = 15_000;

interface BrowserbaseContextCreateResponse {
  id?: string;
}

interface Deps {
  /** Override for tests. Defaults to built-in fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Return the Browserbase context id bound to this Supabase user.
 * Creates + persists one on first access.
 *
 * Throws DomainError('UNAVAILABLE') when BROWSERBASE_API_KEY /
 * BROWSERBASE_PROJECT_ID are not configured, so callers can decide
 * whether to fall back to anonymous sessions or propagate.
 */
export async function getOrCreateBrowserContext(
  queryable: Queryable,
  supabaseUserId: string,
  deps: Deps = {},
): Promise<string> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new DomainError('UNAVAILABLE', 'Browserbase not configured (missing API key or project id)');
  }

  // Fast path: existing row
  const existing = await queryable.query<{ context_id: string }>(
    'SELECT context_id FROM proactive_browser_context WHERE supabase_user_id = $1',
    [supabaseUserId],
  );
  if (existing.rowCount && existing.rows[0]) {
    return existing.rows[0].context_id;
  }

  // Miss: create via Browserbase API
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_CONTEXT_TIMEOUT_MS);
  let contextId: string;
  try {
    const res = await fetchImpl(`${BROWSERBASE_API_BASE}/contexts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': apiKey,
      },
      body: JSON.stringify({ projectId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new DomainError(
        'UNAVAILABLE',
        `Browserbase context create failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as BrowserbaseContextCreateResponse;
    if (!data.id || typeof data.id !== 'string') {
      throw new DomainError('UNAVAILABLE', 'Browserbase context create returned no id');
    }
    contextId = data.id;
  } finally {
    clearTimeout(timer);
  }

  // Race guard: two concurrent spawns for the same user could both hit the
  // miss path. ON CONFLICT keeps the first write and we return that.
  const inserted = await queryable.query<{ context_id: string }>(
    `INSERT INTO proactive_browser_context (supabase_user_id, context_id)
     VALUES ($1, $2)
     ON CONFLICT (supabase_user_id) DO UPDATE SET supabase_user_id = EXCLUDED.supabase_user_id
     RETURNING context_id`,
    [supabaseUserId, contextId],
  );
  return inserted.rows[0]?.context_id ?? contextId;
}
