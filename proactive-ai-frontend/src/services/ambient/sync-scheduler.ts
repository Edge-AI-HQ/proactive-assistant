import type { PersonalSignalInput } from "@/lib/devices";
import { ingestBatch, type IngestStats } from "./ingest-bridge";
import type { OutboxRecord, OutboxStore } from "./outbox";

export interface SyncSchedulerOptions {
  batchLimit?: number;
  intervalMs?: number;
  maxRetryDelayMs?: number;
}

export interface SyncResult {
  attempted: number;
  synced: number;
  failed: number;
  inserted: number;
  ignored: number;
  pruned: number;
  syncedItems: PersonalSignalInput[];
}

export interface SyncSchedulerStatus {
  running: boolean;
  lastDrainTs: number | null;
  lastSuccessTs: number | null;
  lastError: string | null;
}

const DEFAULT_OPTIONS: Required<SyncSchedulerOptions> = {
  batchLimit: 50,
  intervalMs: 60_000,
  maxRetryDelayMs: 15 * 60_000,
};

export class AmbientSyncScheduler {
  private opts: Required<SyncSchedulerOptions>;
  private draining = false;
  private lastDrainTs: number | null = null;
  private lastSuccessTs: number | null = null;
  private lastError: string | null = null;

  constructor(private outbox: OutboxStore, opts: SyncSchedulerOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  intervalMs(): number {
    return this.opts.intervalMs;
  }

  async drain(): Promise<SyncResult> {
    const empty = emptyResult();
    if (this.draining) return empty;
    this.draining = true;
    const now = Date.now();
    this.lastDrainTs = now;

    try {
      const pruned = await this.outbox.prune(now);
      const records = await this.outbox.pending(this.opts.batchLimit, now);
      if (records.length === 0) {
        const remaining = await this.outbox.count();
        if (remaining === 0) {
          this.lastError = null;
          this.lastSuccessTs = now;
        } else {
          console.info("[ambient] outbox drain waiting for retry", {
            remaining,
            lastError: this.lastError,
          });
        }
        return { ...empty, pruned };
      }

      console.info("[ambient] draining outbox", { count: records.length });
      const stats = await ingestBatch(records.map((row) => row.item));
      // Three-bucket classification per the V3 5-state status contract
      // (docs/plans/2026-05-12-v2-to-v3-migration.mdx D-3):
      //   * settledIds:  inserted | duplicate | rejected | parse_failed
      //                  → drop from queue. ``rejected`` and ``parse_failed``
      //                  are permanent client-side bugs; retrying won't
      //                  help, so we log and discard.
      //   * retryableIds: retryable_failed (server-side transient blip),
      //                  or records the response never acknowledged.
      const { settledIds, retryableIds, rejectedDetails } =
        bucketRecords(records, stats);
      if (rejectedDetails.length > 0) {
        console.warn("[ambient] dropping items as permanently rejected", {
          count: rejectedDetails.length,
          samples: rejectedDetails.slice(0, 5),
        });
      }
      await this.outbox.markSynced(settledIds, Date.now());
      if (retryableIds.length > 0) {
        console.warn("[ambient] keeping items for retry", {
          attempted: records.length,
          settled: settledIds.length,
          retryable: retryableIds.length,
        });
        await this.outbox.markFailed(
          retryableIds,
          "retryable_failed or unacknowledged",
          Date.now() + retryDelayMs(records, this.opts.maxRetryDelayMs),
        );
      }
      const syncedIds = settledIds;
      const failedIds = retryableIds;
      const syncedItems = records
        .filter((row) => syncedIds.includes(row.id))
        .map((row) => row.item);
      this.lastError = null;
      this.lastSuccessTs = Date.now();
      return {
        attempted: records.length,
        synced: syncedIds.length,
        failed: failedIds.length,
        inserted: stats.inserted,
        ignored: stats.ignored,
        pruned,
        syncedItems,
      };
    } catch (err) {
      const message = describeError(err);
      this.lastError = message;
      const records = await this.outbox.pending(this.opts.batchLimit, now);
      const nextRetryAt = Date.now() + retryDelayMs(records, this.opts.maxRetryDelayMs);
      console.warn("[ambient] outbox drain failed", {
        attempted: records.length,
        error: message,
        nextRetryAt: new Date(nextRetryAt).toISOString(),
      });
      await this.outbox.markFailed(records.map((row) => row.id), message, nextRetryAt);
      return {
        ...empty,
        attempted: records.length,
        failed: records.length,
      };
    } finally {
      this.draining = false;
    }
  }

  status(): SyncSchedulerStatus {
    return {
      running: false,
      lastDrainTs: this.lastDrainTs,
      lastSuccessTs: this.lastSuccessTs,
      lastError: this.lastError,
    };
  }
}

interface BucketResult {
  /** Outbox row ids to drop (inserted / duplicate / rejected / parse_failed). */
  settledIds: string[];
  /** Outbox row ids to keep & retry (retryable_failed or unacknowledged). */
  retryableIds: string[];
  /** Permanent-rejection rows worth logging (rejected + parse_failed). */
  rejectedDetails: Array<{ id: string; status: string; reason?: string }>;
}

function bucketRecords(records: OutboxRecord[], stats: IngestStats): BucketResult {
  // No per-item results from the server — treat any non-2xx body that
  // still resolved as full retry. Server must always populate
  // ``results`` per the V3 contract, so this is the defensive branch
  // (e.g. older server, malformed JSON).
  if (!stats.results) {
    return {
      settledIds: [],
      retryableIds: records.map((row) => row.id),
      rejectedDetails: [],
    };
  }
  const byItemId = new Map<string, { status: string; reason?: string }>();
  for (const r of stats.results) {
    byItemId.set(r.id, { status: r.status, reason: r.reason });
  }
  const settledIds: string[] = [];
  const retryableIds: string[] = [];
  const rejectedDetails: BucketResult["rejectedDetails"] = [];
  for (const row of records) {
    const itemId = row.item.id ?? row.id;
    const result = byItemId.get(itemId);
    if (!result) {
      // Server never acknowledged this row — treat as retryable.
      retryableIds.push(row.id);
      continue;
    }
    switch (result.status) {
      case "inserted":
      case "duplicate":
        settledIds.push(row.id);
        break;
      case "rejected":
      case "parse_failed":
        settledIds.push(row.id);
        rejectedDetails.push({
          id: itemId, status: result.status, reason: result.reason,
        });
        break;
      case "retryable_failed":
      default:
        retryableIds.push(row.id);
        break;
    }
  }
  return { settledIds, retryableIds, rejectedDetails };
}

function retryDelayMs(records: OutboxRecord[], maxRetryDelayMs: number): number {
  const attempt = Math.max(0, ...records.map((row) => row.attemptCount)) + 1;
  return Math.min(maxRetryDelayMs, 2 ** attempt * 5_000);
}

function emptyResult(): SyncResult {
  return {
    attempted: 0,
    synced: 0,
    failed: 0,
    inserted: 0,
    ignored: 0,
    pruned: 0,
    syncedItems: [],
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export type { IngestStats, PersonalSignalInput };
