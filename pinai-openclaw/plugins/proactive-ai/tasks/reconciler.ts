/**
 * Connector init reconciler.
 *
 * Closes the gap that /composio/wait alone leaves behind: users who
 * complete OAuth then close the tab never trigger our wait poll, so the
 * ACTIVE-detection enqueue never fires. This sweeper periodically asks
 * Composio for ALL ACTIVE connections and enqueues a connector.init for
 * every (toolkit, connectedAccountId) pair that doesn't already have a
 * task in flight or completed.
 *
 * Idempotency:
 *   key = `connector.init:<toolkit>:<connectedAccountId>:v1`
 *   The dedupe column on background_tasks means re-enqueuing the same
 *   key is free — the existing row (queued/running/succeeded) is returned.
 *
 * The reconciler is dependency-injected for testability — production
 * wires it to the live Composio fetcher; tests pass a mock that returns
 * canned `/connected_accounts?statuses=ACTIVE` responses.
 */
import * as db from '../db.js';
import {
  requireComposioApiKey,
  getComposioUserId,
} from '../shared/composio-key.js';
import type { ComposioFetcher } from './handlers/connector-init.js';

export interface ReconcilerDeps {
  fetcher?: ComposioFetcher;
  /** Override Composio user_id for tests. */
  userId?: string;
  /** Per-toolkit init limit override; defaults to 100. */
  defaultLimit?: number;
}

export interface ReconcilerReport {
  /** ACTIVE connections discovered on this sweep. */
  scanned: number;
  /** New connector.init tasks created. */
  enqueued: number;
  /** Connections skipped because a task already exists. */
  alreadyHandled: number;
  /** Connections rejected (missing toolkit/account id, etc). */
  invalid: number;
  /** Hit a Composio error — true means the sweep was incomplete. */
  failed: boolean;
  failedReason?: string;
}

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

/**
 * Run one reconciliation sweep. Idempotent — safe to call repeatedly.
 *
 * Sweeps that fail on the Composio fetch side return failed=true so the
 * scheduler can decide whether to log/back off; it does NOT throw.
 */
export async function reconcileActiveConnectorAccounts(
  deps: ReconcilerDeps = {},
): Promise<ReconcilerReport> {
  let fetcher: ComposioFetcher;
  let userId: string;
  if (deps.fetcher) {
    fetcher = deps.fetcher;
    userId = deps.userId ?? getComposioUserId();
  } else {
    try {
      const apiKey = requireComposioApiKey();
      fetcher = makeDefaultFetcher(apiKey);
      userId = deps.userId ?? getComposioUserId();
    } catch (err) {
      return emptyReport({
        failed: true,
        failedReason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let raw: any;
  try {
    raw = await fetcher(`/connected_accounts?user_ids=${encodeURIComponent(userId)}&statuses=ACTIVE&limit=200`);
  } catch (err) {
    return emptyReport({
      failed: true,
      failedReason: err instanceof Error ? err.message : String(err),
    });
  }

  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  const report: ReconcilerReport = {
    scanned: items.length,
    enqueued: 0,
    alreadyHandled: 0,
    invalid: 0,
    failed: false,
  };

  const limit = deps.defaultLimit ?? Number(process.env.CONNECTOR_INIT_DEFAULT_LIMIT ?? 100);

  for (const item of items) {
    const toolkit = String(
      item?.toolkit?.slug ?? item?.toolkit ?? '',
    ).trim().toLowerCase();
    const connectedAccountId = String(
      item?.id ?? item?.connected_account_id ?? '',
    ).trim();
    if (!toolkit || !connectedAccountId) {
      report.invalid += 1;
      continue;
    }

    const key = `connector.init:${toolkit}:${connectedAccountId}:v1`;
    // Cheap pre-check so we don't churn DB inserts on every sweep
    const existing = await db.getBackgroundTaskByIdempotencyKey(key);
    if (existing) {
      report.alreadyHandled += 1;
      continue;
    }
    const result = await db.enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: key,
      payload: {
        toolkit,
        connectedAccountId,
        limit,
        reason: 'reconciler',
      },
      priority: 50,
      maxAttempts: 3,
    });
    if (result.created) {
      report.enqueued += 1;
    } else {
      // Race with /composio/wait — already enqueued between our pre-check
      // and the insert. Same outcome as alreadyHandled, just narrower window.
      report.alreadyHandled += 1;
    }
  }

  return report;
}

function emptyReport(overrides: Partial<ReconcilerReport>): ReconcilerReport {
  return {
    scanned: 0,
    enqueued: 0,
    alreadyHandled: 0,
    invalid: 0,
    failed: false,
    ...overrides,
  };
}

function makeDefaultFetcher(apiKey: string): ComposioFetcher {
  return async (path, init) => {
    const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
      ...(init as any),
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = text.trim() ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!response.ok) {
      const obj = data && typeof data === 'object' ? data as Record<string, unknown> : null;
      const msg = (typeof obj?.message === 'string' && obj.message)
        || (typeof obj?.error === 'string' && obj.error)
        || (obj && typeof obj === 'object' && (() => { try { return JSON.stringify(obj).slice(0, 400); } catch { return null; } })())
        || text.slice(0, 400);
      throw new Error(`Composio API ${response.status}: ${msg}`);
    }
    return (data as any) ?? {};
  };
}
