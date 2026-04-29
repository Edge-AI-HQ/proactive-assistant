/**
 * Per-user Browserbase context provisioning.
 *
 * A Browserbase "context" is a durable cookie/storage profile that survives
 * across sessions. We bind one to each Supabase user so the AI agent's
 * browser stays logged in to Gmail / calendar / shopping / etc. between
 * runs instead of starting fresh every time.
 *
 * Flow on container spawn:
 *   orchestrator → getOrCreateBrowserContext(pool, userId)
 *   └── SELECT (inside advisory lock) from proactive_browser_context
 *       ├── hit → bump last_used_at → return context_id
 *       └── miss → POST /v1/contexts on Browserbase → INSERT → return
 *   → env BROWSERBASE_CONTEXT_ID=<id> injected into container
 *
 * Inside the container, BrowserbaseManager.createSession reads the env and
 * passes `browserSettings.context = { id, persist: true }`, so Browserbase
 * boots the session from that profile and writes cookies/localStorage back
 * on session close.
 *
 * Concurrency note: `pg_advisory_xact_lock` serializes concurrent spawns
 * for the same Supabase user. Without it two simultaneous spawns could each
 * call `POST /v1/contexts`, race on `INSERT ON CONFLICT`, and leave one
 * context orphaned on Browserbase with no DB pointer. We use a distinct
 * class id (43) from withUserLock's 42 so the locks don't overlap.
 */
import type { Pool } from 'pg';
import { DomainError } from '../common/errors.js';

const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1';
const CREATE_TIMEOUT_MS = 15_000;
const DELETE_TIMEOUT_MS = 10_000;

/** Distinct from withUserLock's 42 to avoid lock collisions. */
const LOCK_CLASS_ID = 43;

interface BrowserbaseContextCreateResponse {
  id?: string;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface Deps {
  /** Override for tests. Defaults to built-in fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const defaultLogger: Logger = {
  info: (msg) => console.log(`[browser-context] ${msg}`),
  warn: (msg) => console.warn(`[browser-context] ${msg}`),
};

/** Mirror withUserLock's hashing: first 4 bytes of the UUID's hex as int32. */
function userLockKey(supabaseUserId: string): number {
  const hash = Buffer.from(supabaseUserId.replace(/-/g, ''), 'hex');
  return hash.readInt32BE(0);
}

/** Short user id for logs — don't leak full UUID. */
function shortUid(supabaseUserId: string): string {
  return supabaseUserId.slice(0, 8);
}

async function createBrowserbaseContext(
  apiKey: string,
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
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
    return data.id;
  } finally {
    clearTimeout(timer);
  }
}

async function deleteBrowserbaseContextRemote(
  contextId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BROWSERBASE_API_BASE}/contexts/${contextId}`, {
      method: 'DELETE',
      headers: { 'X-BB-API-Key': apiKey },
      signal: controller.signal,
    });
    // 404 = already gone on Browserbase; treat as success.
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '');
      logger.warn(
        `Browserbase delete ${contextId} failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    logger.warn(
      `Browserbase delete ${contextId} error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the Browserbase context id bound to this Supabase user.
 * Creates one on first access. Throws DomainError('UNAVAILABLE') when
 * Browserbase isn't configured so the caller (orchestrator) can decide
 * whether to fall back to anonymous sessions.
 */
export async function getOrCreateBrowserContext(
  pool: Pool,
  supabaseUserId: string,
  deps: Deps = {},
): Promise<string> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new DomainError(
      'UNAVAILABLE',
      'Browserbase not configured (missing API key or project id)',
    );
  }
  const logger = deps.logger ?? defaultLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const uid = shortUid(supabaseUserId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      LOCK_CLASS_ID,
      userLockKey(supabaseUserId),
    ]);

    // Re-check inside the lock: another concurrent spawn may have just
    // inserted a row while we waited.
    const existing = await client.query<{ context_id: string }>(
      'SELECT context_id FROM proactive_browser_context WHERE supabase_user_id = $1',
      [supabaseUserId],
    );
    if (existing.rowCount && existing.rows[0]) {
      await client.query(
        `UPDATE proactive_browser_context
         SET last_used_at = NOW()
         WHERE supabase_user_id = $1`,
        [supabaseUserId],
      );
      await client.query('COMMIT');
      logger.info(`hit user=${uid} context=${existing.rows[0].context_id}`);
      return existing.rows[0].context_id;
    }

    // Miss under lock — we're the single creator. No orphan risk.
    const contextId = await createBrowserbaseContext(apiKey, projectId, fetchImpl);
    await client.query(
      `INSERT INTO proactive_browser_context (supabase_user_id, context_id, last_used_at)
       VALUES ($1, $2, NOW())`,
      [supabaseUserId, contextId],
    );
    await client.query('COMMIT');
    logger.info(`create user=${uid} context=${contextId}`);
    return contextId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete the user's Browserbase context — both the DB binding and the
 * remote context on Browserbase. Idempotent: missing DB rows and
 * Browserbase 404s are silently OK.
 *
 * Called by:
 *   - deleteUserAccount (cascade on account deletion)
 *   - POST /api/proactive/browser/context/reset (user-facing "clear cookies")
 *
 * Note: this only clears server-side state. A container that's already
 * running with BROWSERBASE_CONTEXT_ID pointing at the old context will
 * keep using it until respawned. That's fine for the "cleared on next
 * session" semantics we want; if we ever need instant effect the caller
 * can additionally `destroySession` the container.
 */
export async function deleteBrowserContext(
  pool: Pool,
  supabaseUserId: string,
  deps: Deps = {},
): Promise<void> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const logger = deps.logger ?? defaultLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const uid = shortUid(supabaseUserId);

  const row = await pool.query<{ context_id: string }>(
    `DELETE FROM proactive_browser_context
     WHERE supabase_user_id = $1
     RETURNING context_id`,
    [supabaseUserId],
  );
  const contextId = row.rows[0]?.context_id;
  if (!contextId) {
    logger.info(`delete user=${uid} no-op (no row)`);
    return;
  }
  logger.info(`delete user=${uid} context=${contextId}`);

  // Best-effort remote delete. If it fails Browserbase holds an orphan
  // context but our DB is clean — next spawn creates a fresh one, no
  // user-visible impact beyond a single context leaked on their side.
  if (apiKey) {
    await deleteBrowserbaseContextRemote(contextId, apiKey, fetchImpl, logger);
  }
}
