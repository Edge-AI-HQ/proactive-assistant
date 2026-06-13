/**
 * Ambient device-signal outbox — durable queue between local ambient capture
 * and POST /api/devices/ingest. Pure logic only (interface + in-memory store +
 * dedupe/TTL/retry helpers); each app keeps its own SQLite-backed store (web
 * @capacitor-community/sqlite, RN expo-sqlite) and imports the helpers exported
 * here. Lifted from web services/ambient/outbox.ts so the RN durable outbox can
 * reuse one implementation instead of re-deriving dedupe semantics.
 */
import type { PersonalSignalInput } from "../domain/signals";
import { stableHash, stripTranscriptSegmentLabels } from "../domain/ambient/utils";

export type OutboxKind = "memory" | "sqlite";
export type OutboxStatus = "pending" | "synced" | "failed";

export interface OutboxRecord {
  id: string;
  item: PersonalSignalInput;
  dedupeKey: string;
  status: OutboxStatus;
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: number | null;
  insertedAt: number;
  updatedAt: number;
  syncedAt: number | null;
  syncedOwnerUserId: string | null;
  syncedBackendUrl: string | null;
}

export interface OutboxStore {
  readonly kind: OutboxKind;
  enqueue(items: PersonalSignalInput[]): Promise<number>;
  pending(
    limit: number,
    now?: number,
    ownerUserId?: string | null,
    backendUrl?: string | null,
  ): Promise<OutboxRecord[]>;
  markSynced(
    ids: string[],
    at?: number,
    ownerUserId?: string | null,
    backendUrl?: string | null,
  ): Promise<void>;
  markFailed(ids: string[], error: string, nextRetryAt: number): Promise<void>;
  prune(now?: number): Promise<number>;
  count(ownerUserId?: string | null, backendUrl?: string | null): Promise<number>;
}

// Exported for platform OutboxStore implementations (web/RN SQLite prune).
export const SYNCED_RETENTION_MS = 86_400_000;
export const DEFAULT_TTL_MS = 7 * 86_400_000;

export class MemoryOutboxStore implements OutboxStore {
  readonly kind = "memory" as const;
  private records: OutboxRecord[] = [];

  async enqueue(items: PersonalSignalInput[]): Promise<number> {
    let inserted = 0;
    const now = Date.now();
    for (const item of items) {
      const record = makeRecord(item, now);
      const existingIndex = this.records.findIndex((row) => row.dedupeKey === record.dedupeKey);
      if (existingIndex < 0) {
        this.records.push(record);
        inserted += 1;
        continue;
      }
      const existing = this.records[existingIndex];
      if (!existing) continue;
      if (!shouldReplaceExistingOutboxRecord(existing, record)) {
        continue;
      }
      this.records[existingIndex] = replaceExistingOutboxRecord(existing, record, now);
      inserted += 1;
    }
    return inserted;
  }

  async pending(
    limit: number,
    now = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<OutboxRecord[]> {
    return this.records
      .filter((row) => isReady(row, now, ownerUserId, backendUrl))
      .sort(compareRecords)
      .slice(0, limit)
      .map(cloneRecord);
  }

  async markSynced(
    ids: string[],
    at = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const row of this.records) {
      if (!idSet.has(row.id)) continue;
      row.status = "synced";
      row.syncedAt = at;
      row.syncedOwnerUserId = ownerUserId;
      row.syncedBackendUrl = backendUrl;
      row.nextRetryAt = null;
      row.lastError = null;
      row.updatedAt = at;
    }
  }

  async markFailed(ids: string[], error: string, nextRetryAt: number): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const row of this.records) {
      if (!idSet.has(row.id)) continue;
      row.status = "failed";
      row.attemptCount += 1;
      row.lastError = error;
      row.nextRetryAt = nextRetryAt;
      row.updatedAt = Date.now();
    }
  }

  async prune(now = Date.now()): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((row) => {
      if (row.status === "synced") {
        return row.syncedAt === null || row.syncedAt >= now - SYNCED_RETENTION_MS;
      }
      return recordExpiresAt(row) > now;
    });
    return before - this.records.length;
  }

  async count(
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<number> {
    return this.records.filter((row) => isUnsettledForScope(row, ownerUserId, backendUrl)).length;
  }
}

// makeRecord / normalizeTranscriptCandidateSignal / shouldReplaceExistingOutboxRecord
// are exported for platform OutboxStore implementations (web/RN SQLite) that
// reuse the same record shaping + dedupe semantics as MemoryOutboxStore.
export function makeRecord(item: PersonalSignalInput, now: number): OutboxRecord {
  const id = item.id ?? generateId();
  const occurredAt = item.occurred_at ?? new Date(now).toISOString();
  const normalized: PersonalSignalInput = {
    ...item,
    id,
    occurred_at: occurredAt,
  };
  const dedupeKey = normalized.dedupe_key ?? `${normalized.kind}:${id}`;
  normalized.dedupe_key = dedupeKey;
  const canonicalDedupeKey = transcriptCandidateDedupeKey(normalized) ?? dedupeKey;
  normalized.dedupe_key = canonicalDedupeKey;
  const itemForRecord = normalizeTranscriptCandidateSignal(normalized);

  return {
    id,
    item: itemForRecord,
    dedupeKey: canonicalDedupeKey,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    nextRetryAt: null,
    insertedAt: now,
    updatedAt: now,
    syncedAt: null,
    syncedOwnerUserId: null,
    syncedBackendUrl: null,
  };
}

export function normalizeTranscriptCandidateSignal(item: PersonalSignalInput): PersonalSignalInput {
  if (!isTranscriptCandidateWindow(item)) return item;
  const payload = item.payload ?? {};
  const compactContext = cleanPayloadString(payload.compact_context);
  const cleanSummary = stripTranscriptSegmentLabels(item.summary);
  const cleanCompactContext = compactContext
    ? stripTranscriptSegmentLabels(compactContext)
    : null;
  if (cleanSummary === item.summary && cleanCompactContext === compactContext) {
    return item;
  }
  const hashSource = cleanCompactContext || cleanSummary;
  return {
    ...item,
    summary: cleanSummary || item.summary,
    payload: {
      ...payload,
      ...(cleanCompactContext ? { compact_context: cleanCompactContext } : {}),
      ...(hashSource ? { content_hash: stableHash(hashSource) } : {}),
    },
  };
}

export function shouldReplaceExistingOutboxRecord(
  existing: OutboxRecord,
  incoming: OutboxRecord,
): boolean {
  if (!isTranscriptCandidateWindow(existing.item) || !isTranscriptCandidateWindow(incoming.item)) {
    return false;
  }
  const existingFreshness = candidateWindowFreshness(existing.item);
  const incomingFreshness = candidateWindowFreshness(incoming.item);
  if (incomingFreshness.rawRefCount > existingFreshness.rawRefCount) return true;
  if (incomingFreshness.rawRefCount < existingFreshness.rawRefCount) return false;
  return incomingFreshness.contentHash !== existingFreshness.contentHash;
}

function replaceExistingOutboxRecord(
  existing: OutboxRecord,
  incoming: OutboxRecord,
  now: number,
): OutboxRecord {
  return {
    ...existing,
    item: incoming.item,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    nextRetryAt: null,
    updatedAt: now,
    syncedAt: null,
    syncedOwnerUserId: null,
    syncedBackendUrl: null,
  };
}

function isTranscriptCandidateWindow(item: PersonalSignalInput): boolean {
  return transcriptCandidateDedupeKey(item) !== null;
}

function transcriptCandidateDedupeKey(item: PersonalSignalInput): string | null {
  if (item.kind !== "ambient.candidate_window") return null;
  const payload = item.payload ?? {};
  if (payload.window_type !== "transcript_session") return null;
  const localDate = cleanPayloadString(payload.local_date);
  const localWindowId = cleanPayloadString(payload.local_window_id);
  if (!localDate || !localWindowId) return null;
  return `ambient:candidate_window:${localDate}:transcript_session:${localWindowId}`;
}

function candidateWindowFreshness(item: PersonalSignalInput): {
  rawRefCount: number;
  contentHash: string | null;
} {
  const payload = item.payload ?? {};
  return {
    rawRefCount: nonNegativeInteger(payload.raw_ref_count),
    contentHash: cleanPayloadString(payload.content_hash),
  };
}

function cleanPayloadString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

function isReady(
  row: OutboxRecord,
  now: number,
  ownerUserId: string | null,
  backendUrl: string | null,
): boolean {
  if (!isUnsettledForScope(row, ownerUserId, backendUrl)) return false;
  if (recordAvailableAt(row) > now) return false;
  if (recordExpiresAt(row) <= now) return false;
  return row.nextRetryAt === null || row.nextRetryAt <= now;
}

function isUnsettledForScope(
  row: OutboxRecord,
  ownerUserId: string | null,
  backendUrl: string | null,
): boolean {
  if (row.status !== "synced") return true;
  if (ownerUserId && row.syncedOwnerUserId !== ownerUserId) return true;
  if (backendUrl && row.syncedBackendUrl !== backendUrl) return true;
  return false;
}

function compareRecords(a: OutboxRecord, b: OutboxRecord): number {
  const availableDelta = recordAvailableAt(a) - recordAvailableAt(b);
  if (availableDelta !== 0) return availableDelta;
  return recordOccurredAt(a) - recordOccurredAt(b);
}

function recordAvailableAt(row: OutboxRecord): number {
  return parseTime(row.item.available_at) ?? recordOccurredAt(row);
}

function recordOccurredAt(row: OutboxRecord): number {
  return parseTime(row.item.occurred_at) ?? row.insertedAt;
}

function recordExpiresAt(row: OutboxRecord): number {
  return parseTime(row.item.expires_at) ?? row.insertedAt + DEFAULT_TTL_MS;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function cloneRecord(record: OutboxRecord): OutboxRecord {
  return {
    ...record,
    item: {
      ...record.item,
      payload: record.item.payload ? { ...record.item.payload } : undefined,
    },
  };
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `outbox-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

