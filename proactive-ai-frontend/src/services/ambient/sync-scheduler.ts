import type { PersonalSignalInput } from "@/lib/devices";
import { ingestBatch, type IngestStats } from "./ingest-bridge";
import type { OutboxRecord, OutboxStore } from "./outbox";
import { AMBIENT_CANDIDATE_WINDOW_KIND, AMBIENT_TIMELINE_KIND } from "./timeline";

export interface SyncSchedulerOptions {
  batchLimit?: number;
  intervalMs?: number;
  maxRetryDelayMs?: number;
  ownerUserIdProvider?: () => Promise<string | null>;
  backendUrlProvider?: () => string | null;
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
  uploadsLocked: boolean;
}

const SYNCABLE_AMBIENT_KINDS = new Set([
  AMBIENT_TIMELINE_KIND,
  AMBIENT_CANDIDATE_WINDOW_KIND,
  "health.observation",
]);

// DATA-FLOW OPEN (2026-06-30): upload EVERY captured ambient kind (voice
// session_summary, visit, motion, location, activity, …) so we can see the real
// volume/shape in pai_raw + events before designing gates. When true, the
// SYNCABLE_AMBIENT_KINDS allowlist below is bypassed — it stays wired as the
// "narrow again" list: flip this to false to restore whitelist-only upload.
// The backend keeps its own per-kind policy (device_ingest/policies.py) as the
// second, independent gate, so this only opens the client half.
const AMBIENT_SYNC_PASSTHROUGH = true;

const DEFAULT_OPTIONS: Required<SyncSchedulerOptions> = {
  batchLimit: 50,
  intervalMs: 60_000,
  maxRetryDelayMs: 15 * 60_000,
  ownerUserIdProvider: async () => null,
  backendUrlProvider: () => null,
};

export class AmbientSyncScheduler {
  private opts: Required<SyncSchedulerOptions>;
  private draining = false;
  private lastDrainTs: number | null = null;
  private lastSuccessTs: number | null = null;
  private lastError: string | null = null;
  private uploadsLocked = false;

  constructor(private outbox: OutboxStore, opts: SyncSchedulerOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  intervalMs(): number {
    return this.opts.intervalMs;
  }

  setUploadsLocked(value: boolean): void {
    this.uploadsLocked = !!value;
  }

  isUploadsLocked(): boolean {
    return this.uploadsLocked;
  }

  async drain(): Promise<SyncResult> {
    const empty = emptyResult();
    if (this.draining) return empty;
    this.draining = true;
    const now = Date.now();
    this.lastDrainTs = now;

    if (this.uploadsLocked) {
      // Soft lock parity with the old iOS ``pa.globalLock`` setting:
      // keep collecting local signals into the outbox, but never call
      // the ingest bridge until the user unlocks uploads explicitly.
      this.draining = false;
      return empty;
    }

    try {
      const ownerUserId = await this.opts.ownerUserIdProvider();
      const backendUrl = this.opts.backendUrlProvider();
      const pruned = await this.outbox.prune(now);
      const pendingRecords = await this.outbox.pending(
        this.opts.batchLimit,
        now,
        ownerUserId,
        backendUrl,
      );
      const records = pendingRecords.filter(
        (row) => AMBIENT_SYNC_PASSTHROUGH || SYNCABLE_AMBIENT_KINDS.has(row.item.kind),
      );
      const localOnlyRecords = AMBIENT_SYNC_PASSTHROUGH
        ? []
        : pendingRecords.filter((row) => !SYNCABLE_AMBIENT_KINDS.has(row.item.kind));
      if (localOnlyRecords.length > 0) {
        console.warn("[ambient] dropping local-only source items before sync", {
          count: localOnlyRecords.length,
          kinds: Array.from(new Set(localOnlyRecords.map((row) => row.item.kind))),
        });
        await this.outbox.markSynced(
          localOnlyRecords.map((row) => row.id),
          Date.now(),
          ownerUserId,
          backendUrl,
        );
      }
      if (records.length === 0) {
        const remaining = await this.outbox.count(ownerUserId, backendUrl);
        if (remaining === 0) {
          this.lastError = null;
          this.lastSuccessTs = now;
        } else {
          console.info("[ambient] outbox drain waiting for retry", {
            remaining,
            lastError: this.lastError,
          });
        }
        return { ...empty, ignored: localOnlyRecords.length, pruned };
      }

      console.info("[ambient] draining outbox", { count: records.length });
      const stats = await ingestBatch(records.map((row) => row.item));
      // Three-bucket classification per the V3 status contract:
      //   * settledIds:  inserted | duplicate | filtered | rejected |
      //                  parse_failed → drop from queue. ``rejected`` /
      //                  ``parse_failed`` are permanent client-side bugs;
      //                  ``filtered`` is a deferred-sink kind the server
      //                  dropped on purpose; none are worth retrying.
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
      await this.outbox.markSynced(settledIds, Date.now(), ownerUserId, backendUrl);
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
      uploadsLocked: this.uploadsLocked,
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
      case "filtered":
        // ``filtered``: server accepted but intentionally did not persist
        // (a kind whose cloud sink is deferred). Drop from queue — retrying
        // won't change the outcome.
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
