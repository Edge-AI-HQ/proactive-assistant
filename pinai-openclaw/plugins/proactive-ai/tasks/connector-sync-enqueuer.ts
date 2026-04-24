/**
 * Connector sync enqueuer.
 *
 * Companion to tasks/handlers/connector-sync.ts: handler does the work, this
 * decides WHEN to enqueue. Mirrors the reconciler shape (scan ACTIVE Composio
 * accounts) but uses windowed idempotency + the per-account cursor row to gate
 * "is this account due for another sync?".
 *
 * Design (matches data-connectors.mdx):
 *   - intervalMs = CONNECTOR_SYNC_INTERVAL_MS (default 12h) — how often each
 *     account syncs at most.
 *   - windowStart = floor(now / intervalMs) * intervalMs — the current window
 *     boundary in epoch ms. Idempotency key includes windowStart, so two
 *     enqueuer fires within the same window collide on the unique key (the
 *     second is a no-op).
 *   - Per-account gate: if connector_sync_cursors.last_synced_at >= windowStart
 *     the account already synced this window, skip.
 *   - Init gate: skip if `connector.init:<toolkit>:<accountId>:v1` is not in
 *     status='succeeded'. We don't sync until the first init is done, so the
 *     two paths don't race the same account.
 *
 * Failure semantics mirror the reconciler — a Composio fetch failure does NOT
 * throw, it returns failed=true and the periodic timer just retries next tick.
 */
import * as db from '../db.js';
import {
  requireComposioApiKey,
  getComposioUserId,
} from '../shared/composio-key.js';
import type { ComposioFetcher } from './handlers/connector-init.js';

export interface ConnectorSyncEnqueuerDeps {
  fetcher?: ComposioFetcher;
  /** Override Composio user_id for tests. */
  userId?: string;
  /** Override "now" for tests. */
  now?: Date;
  /** Override CONNECTOR_SYNC_INTERVAL_MS for tests (ms). */
  intervalMsOverride?: number;
  /** Per-toolkit init limit forwarded into the sync task payload. */
  defaultLimit?: number;
}

export interface ConnectorSyncEnqueuerReport {
  scanned: number;
  enqueued: number;
  /** Account is up-to-date in the current window. */
  alreadyHandled: number;
  /** connector.init for this account hasn't succeeded yet. */
  awaitingInit: number;
  /** Composio returned an item missing toolkit/account fields. */
  invalid: number;
  /** Composio fetch failed — the sweep is incomplete (will retry next tick). */
  failed: boolean;
  failedReason?: string;
}

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Run one enqueue sweep. Idempotent — safe to call from a setInterval timer.
 * Returns a report; never throws.
 */
export async function enqueueDueConnectorSyncs(
  deps: ConnectorSyncEnqueuerDeps = {},
): Promise<ConnectorSyncEnqueuerReport> {
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
    raw = await fetcher(
      `/connected_accounts?user_ids=${encodeURIComponent(userId)}&statuses=ACTIVE&limit=200`,
    );
  } catch (err) {
    return emptyReport({
      failed: true,
      failedReason: err instanceof Error ? err.message : String(err),
    });
  }

  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  const report: ConnectorSyncEnqueuerReport = {
    scanned: items.length,
    enqueued: 0,
    alreadyHandled: 0,
    awaitingInit: 0,
    invalid: 0,
    failed: false,
  };

  const now = deps.now ?? new Date();
  const intervalMs = resolveIntervalMs(deps.intervalMsOverride);
  const windowStart = Math.floor(now.getTime() / intervalMs) * intervalMs;
  const limit = deps.defaultLimit
    ?? Number(process.env.CONNECTOR_INIT_DEFAULT_LIMIT ?? 100);

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

    // 1. Init gate — sync waits until the first init has succeeded.
    const initKey = `connector.init:${toolkit}:${connectedAccountId}:v1`;
    const initTask = await db.getBackgroundTaskByIdempotencyKey(initKey);
    if (!initTask || initTask.status !== 'succeeded') {
      report.awaitingInit += 1;
      continue;
    }

    // 2. Window gate — already synced in this window?
    const cursor = await db.getConnectorSyncCursor(toolkit, connectedAccountId);
    if (cursor) {
      const lastSyncedMs = Date.parse(cursor.last_synced_at);
      if (Number.isFinite(lastSyncedMs) && lastSyncedMs >= windowStart) {
        report.alreadyHandled += 1;
        continue;
      }
    }

    // 3. Enqueue. Idempotency key includes windowStart so concurrent
    //    enqueuer fires in the same window collide harmlessly.
    const key = `connector.sync:${toolkit}:${connectedAccountId}:${windowStart}`;
    const result = await db.enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: key,
      priority: 50,
      maxAttempts: 2, // sync is cheap to retry; cap at 2 so a permanently
                     // broken account doesn't burn 3× cost every window.
      payload: {
        toolkit,
        connectedAccountId,
        limit,
        reason: 'enqueuer',
      },
    });
    if (result.created) {
      report.enqueued += 1;
    } else {
      // Race with another enqueuer fire (or manual enqueue) in the same
      // window — same outcome, narrower window.
      report.alreadyHandled += 1;
    }
  }

  return report;
}

function resolveIntervalMs(override: number | undefined): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  const fromEnv = Number(process.env.CONNECTOR_SYNC_INTERVAL_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_INTERVAL_MS;
}

function emptyReport(overrides: Partial<ConnectorSyncEnqueuerReport>): ConnectorSyncEnqueuerReport {
  return {
    scanned: 0,
    enqueued: 0,
    alreadyHandled: 0,
    awaitingInit: 0,
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
        || (obj && typeof obj === 'object'
            ? (() => { try { return JSON.stringify(obj).slice(0, 400); } catch { return null; } })()
            : null)
        || text.slice(0, 400);
      throw new Error(`Composio API ${response.status}: ${msg}`);
    }
    return (data as any) ?? {};
  };
}
