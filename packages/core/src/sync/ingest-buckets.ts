// Per-item ingest result bucketing + retry backoff — lifted verbatim from
// proactive-ai-frontend/src/services/ambient/sync-scheduler.ts so the RN
// outbox drain applies the same V3 three-bucket contract as the web/Capacitor
// scheduler. The dev file keeps its own private copy for now (no consumer
// switch); this is the shared SSOT for new consumers.
import type { IngestResult } from "../domain/signals";
import {
  AMBIENT_CANDIDATE_WINDOW_KIND,
  AMBIENT_TIMELINE_KIND,
} from "../domain/ambient/types";
import type { OutboxRecord } from "./ambient-outbox";

/**
 * Kinds that are allowed to leave the device. Everything else in the outbox
 * is a local-only source item (raw sensor push) that must be dropped before
 * sync — the server only consumes the distilled pipeline output.
 */
export const SYNCABLE_AMBIENT_KINDS = new Set([
  AMBIENT_TIMELINE_KIND,
  AMBIENT_CANDIDATE_WINDOW_KIND,
  "health.observation",
]);

export interface BucketResult {
  /** Outbox row ids to drop (inserted / duplicate / rejected / parse_failed). */
  settledIds: string[];
  /** Outbox row ids to keep & retry (retryable_failed or unacknowledged). */
  retryableIds: string[];
  /** Permanent-rejection rows worth logging (rejected + parse_failed). */
  rejectedDetails: Array<{ id: string; status: string; reason?: string }>;
}

export function bucketRecords(records: OutboxRecord[], stats: IngestResult): BucketResult {
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

export function retryDelayMs(records: OutboxRecord[], maxRetryDelayMs: number): number {
  const attempt = Math.max(0, ...records.map((row) => row.attemptCount)) + 1;
  return Math.min(maxRetryDelayMs, 2 ** attempt * 5_000);
}
