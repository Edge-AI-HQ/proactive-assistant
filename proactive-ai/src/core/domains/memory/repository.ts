import { and, desc, eq } from "drizzle-orm";

import type { SqliteDatabase } from "../../db/sqlite_adapter.js";
import {
  memoryEntries,
  memoryEvents,
  type MemoryEntryRecord,
  type MemoryEventRecord,
  type NewMemoryEntryRecord,
  type NewMemoryEventRecord,
} from "./schema.js";

export interface RecordMemoryEventInput {
  profileId: string;
  source: string;
  kind: string;
  subjectType: string;
  subjectKey: string;
  text: string;
  payload?: Record<string, unknown>;
  confidence?: number;
  occurredAt?: string;
}

export interface ListMemoryEventsInput {
  limit?: number;
  subjectType?: string;
  subjectKey?: string;
}

export interface SearchMemoryEventsInput extends ListMemoryEventsInput {
  query: string;
}

export interface UpsertMemoryEntryInput {
  profileId: string;
  category: string;
  text: string;
  sourceEventIds: string[];
  evidenceCount: number;
  score: number;
  metadata?: Record<string, unknown>;
  lastConfirmedAt?: string | null;
}

export interface ListMemoryEntriesInput {
  limit?: number;
  status?: string;
  category?: string;
}

const nextId = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export class MemoryRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async recordEvent(input: RecordMemoryEventInput): Promise<MemoryEventRecord> {
    await this.ensureSchema();

    const now = new Date().toISOString();
    const values: NewMemoryEventRecord = {
      id: nextId("mev"),
      profileId: input.profileId,
      source: input.source,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      text: input.text,
      payload: input.payload ?? {},
      confidence: input.confidence ?? 1,
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };

    this.database.orm.insert(memoryEvents).values(values).run();
    return this.getEventById(values.id) as Promise<MemoryEventRecord>;
  }

  async getEventById(id: string): Promise<MemoryEventRecord | null> {
    await this.ensureSchema();
    const result = this.database.orm
      .select()
      .from(memoryEvents)
      .where(eq(memoryEvents.id, id))
      .limit(1)
      .all();

    return result[0] ?? null;
  }

  async listEvents(
    profileId: string,
    options: ListMemoryEventsInput = {},
  ): Promise<MemoryEventRecord[]> {
    await this.ensureSchema();

    const conditions = [eq(memoryEvents.profileId, profileId)];
    if (options.subjectType) {
      conditions.push(eq(memoryEvents.subjectType, options.subjectType));
    }
    if (options.subjectKey) {
      conditions.push(eq(memoryEvents.subjectKey, options.subjectKey));
    }

    return this.database.orm
      .select()
      .from(memoryEvents)
      .where(and(...conditions))
      .orderBy(desc(memoryEvents.occurredAt), desc(memoryEvents.createdAt))
      .limit(options.limit ?? 20)
      .all();
  }

  async searchEvents(
    profileId: string,
    options: SearchMemoryEventsInput,
  ): Promise<MemoryEventRecord[]> {
    const normalized = options.query.trim().toLowerCase();
    if (!normalized) {
      return this.listEvents(profileId, options);
    }

    const rows = await this.listEvents(profileId, {
      limit: Math.max(options.limit ?? 20, 100),
      subjectType: options.subjectType,
      subjectKey: options.subjectKey,
    });

    return rows
      .filter((row) =>
        [row.text, row.subjectType, row.subjectKey, row.kind, row.source]
          .join(" ")
          .toLowerCase()
          .includes(normalized),
      )
      .slice(0, options.limit ?? 20);
  }

  async getEntryById(id: string): Promise<MemoryEntryRecord | null> {
    await this.ensureSchema();
    const result = this.database.orm
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, id))
      .limit(1)
      .all();

    return result[0] ?? null;
  }

  async listEntries(
    profileId: string,
    options: ListMemoryEntriesInput = {},
  ): Promise<MemoryEntryRecord[]> {
    await this.ensureSchema();

    const conditions = [eq(memoryEntries.profileId, profileId)];
    if (options.status) {
      conditions.push(eq(memoryEntries.status, options.status));
    }
    if (options.category) {
      conditions.push(eq(memoryEntries.category, options.category));
    }

    return this.database.orm
      .select()
      .from(memoryEntries)
      .where(and(...conditions))
      .orderBy(desc(memoryEntries.score), desc(memoryEntries.updatedAt))
      .limit(options.limit ?? 20)
      .all();
  }

  async upsertEntry(
    input: UpsertMemoryEntryInput,
  ): Promise<MemoryEntryRecord> {
    await this.ensureSchema();

    const inputSubjectKey =
      typeof input.metadata?.subjectKey === "string"
        ? input.metadata.subjectKey
        : null;
    const candidates = this.database.orm
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.profileId, input.profileId),
          eq(memoryEntries.category, input.category),
        ),
      )
      .all();

    const existing = candidates.find((entry) => {
      const existingSubjectKey =
        typeof entry.metadata?.subjectKey === "string"
          ? entry.metadata.subjectKey
          : null;

      if (inputSubjectKey && existingSubjectKey) {
        return existingSubjectKey === inputSubjectKey;
      }

      return entry.text === input.text;
    });

    const now = new Date().toISOString();

    if (existing) {
      const result = this.database.orm
        .update(memoryEntries)
        .set({
          text: input.text,
          score: input.score,
          evidenceCount: input.evidenceCount,
          sourceEventIds: input.sourceEventIds,
          metadata: {
            ...(existing.metadata ?? {}),
            ...(input.metadata ?? {}),
          },
          status: "active",
          lastConfirmedAt: input.lastConfirmedAt ?? existing.lastConfirmedAt ?? null,
          updatedAt: now,
        })
        .where(eq(memoryEntries.id, existing.id))
        .returning()
        .all();

      return result[0] as MemoryEntryRecord;
    }

    const values: NewMemoryEntryRecord = {
      id: nextId("mem"),
      profileId: input.profileId,
      category: input.category,
      text: input.text,
      status: "active",
      score: input.score,
      evidenceCount: input.evidenceCount,
      sourceEventIds: input.sourceEventIds,
      metadata: input.metadata ?? {},
      lastConfirmedAt: input.lastConfirmedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.database.orm.insert(memoryEntries).values(values).run();
    return this.getEntryById(values.id) as Promise<MemoryEntryRecord>;
  }

  async suppressEntry(
    profileId: string,
    entryId: string,
    input?: { reason?: string },
  ): Promise<MemoryEntryRecord | null> {
    await this.ensureSchema();
    const existing = this.database.orm
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.id, entryId),
          eq(memoryEntries.profileId, profileId),
        ),
      )
      .limit(1)
      .all()[0];

    if (!existing) {
      return null;
    }

    const result = this.database.orm
      .update(memoryEntries)
      .set({
        status: "suppressed",
        metadata: {
          ...(existing.metadata ?? {}),
          ...(input?.reason ? { reason: input.reason } : {}),
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(memoryEntries.id, existing.id))
      .returning()
      .all();

    return result[0] ?? null;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id text primary key not null,
        profile_id text not null,
        source text not null,
        kind text not null,
        subject_type text not null,
        subject_key text not null,
        text text not null,
        payload text not null default '{}',
        confidence real not null default 1,
        occurred_at text not null,
        created_at text not null
      )
    `);

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id text primary key not null,
        profile_id text not null,
        category text not null,
        text text not null,
        status text not null default 'active',
        score real not null default 0,
        evidence_count integer not null default 0,
        source_event_ids text not null default '[]',
        metadata text not null default '{}',
        last_confirmed_at text,
        created_at text not null,
        updated_at text not null
      )
    `);

    this.schemaReady = true;
  }
}
