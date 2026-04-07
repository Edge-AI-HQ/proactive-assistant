import { eq, and, gte, desc, like } from "drizzle-orm";

import type { SqliteDatabase } from "../../db/sqlite_adapter.js";
import {
  pushRecords,
  pushOutcomes,
  type PushRecordRow,
  type NewPushRecordRow,
  type PushOutcomeRow,
  type NewPushOutcomeRow,
} from "./schema.js";

export interface CreatePushRecordInput {
  intentCardId?: string;
  kind: string;
  basket?: string;
  title: string;
  channel?: string;
  ref?: string;
  reason?: string;
  pushedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ListPushInput {
  kind?: string;
  basket?: string;
  channel?: string;
  since?: string;
  limit: number;
}

export interface FindSimilarInput {
  kind: string;
  ref?: string;
  title?: string;
  since?: string;
  limit: number;
}

export interface CreateOutcomeInput {
  pushId: string;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface PushRecordWithOutcomes extends PushRecordRow {
  outcomes: PushOutcomeRow[];
}

const nextPushId = (): string =>
  `push_${Math.random().toString(36).slice(2, 10)}`;

const nextOutcomeId = (): string =>
  `po_${Math.random().toString(36).slice(2, 10)}`;

export class PushRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async createRecord(input: CreatePushRecordInput): Promise<PushRecordRow> {
    await this.ensureSchema();

    const id = nextPushId();
    const now = new Date().toISOString();

    const values: NewPushRecordRow = {
      id,
      intentCardId: input.intentCardId ?? null,
      kind: input.kind,
      basket: input.basket ?? null,
      title: input.title,
      channel: input.channel ?? null,
      ref: input.ref ?? null,
      reason: input.reason ?? null,
      pushedAt: input.pushedAt ?? now,
      metadata: input.metadata ?? {},
      createdAt: now,
    };

    this.database.orm.insert(pushRecords).values(values).run();
    return (await this.getRecordById(id)) as PushRecordRow;
  }

  async getRecordById(id: string): Promise<PushRecordRow | null> {
    await this.ensureSchema();
    const result = this.database.orm
      .select()
      .from(pushRecords)
      .where(eq(pushRecords.id, id))
      .limit(1)
      .all();

    return result[0] ?? null;
  }

  async getRecordWithOutcomes(id: string): Promise<PushRecordWithOutcomes | null> {
    await this.ensureSchema();
    const record = await this.getRecordById(id);
    if (!record) return null;

    const outcomes = this.database.orm
      .select()
      .from(pushOutcomes)
      .where(eq(pushOutcomes.pushId, id))
      .orderBy(desc(pushOutcomes.recordedAt))
      .all();

    return { ...record, outcomes };
  }

  async listRecords(input: ListPushInput): Promise<PushRecordRow[]> {
    await this.ensureSchema();

    const conditions = [];

    if (input.kind) {
      conditions.push(eq(pushRecords.kind, input.kind));
    }
    if (input.basket) {
      conditions.push(eq(pushRecords.basket, input.basket));
    }
    if (input.channel) {
      conditions.push(eq(pushRecords.channel, input.channel));
    }
    if (input.since) {
      conditions.push(gte(pushRecords.pushedAt, input.since));
    }

    const query = this.database.orm
      .select()
      .from(pushRecords)
      .orderBy(desc(pushRecords.pushedAt))
      .limit(input.limit);

    if (conditions.length > 0) {
      return query.where(and(...conditions)).all();
    }

    return query.all();
  }

  async createOutcome(input: CreateOutcomeInput): Promise<PushOutcomeRow> {
    await this.ensureSchema();

    const id = nextOutcomeId();
    const now = new Date().toISOString();

    const values: NewPushOutcomeRow = {
      id,
      pushId: input.pushId,
      status: input.status,
      metadata: input.metadata ?? {},
      recordedAt: now,
    };

    this.database.orm.insert(pushOutcomes).values(values).run();

    const result = this.database.orm
      .select()
      .from(pushOutcomes)
      .where(eq(pushOutcomes.id, id))
      .limit(1)
      .all();

    return result[0] as PushOutcomeRow;
  }

  async findSimilar(input: FindSimilarInput): Promise<PushRecordRow[]> {
    await this.ensureSchema();

    const conditions = [eq(pushRecords.kind, input.kind)];

    if (input.since) {
      conditions.push(gte(pushRecords.pushedAt, input.since));
    }
    if (input.ref) {
      conditions.push(eq(pushRecords.ref, input.ref));
    }
    if (input.title) {
      conditions.push(like(pushRecords.title, `%${input.title}%`));
    }

    return this.database.orm
      .select()
      .from(pushRecords)
      .where(and(...conditions))
      .orderBy(desc(pushRecords.pushedAt))
      .limit(input.limit)
      .all();
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS push_records (
        id              TEXT PRIMARY KEY NOT NULL,
        intent_card_id  TEXT,
        kind            TEXT NOT NULL,
        basket          TEXT,
        title           TEXT NOT NULL,
        channel         TEXT,
        ref             TEXT,
        reason          TEXT,
        pushed_at       TEXT NOT NULL,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      )
    `);

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS push_outcomes (
        id          TEXT PRIMARY KEY NOT NULL,
        push_id     TEXT NOT NULL,
        status      TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}',
        recorded_at TEXT NOT NULL
      )
    `);

    this.schemaReady = true;
  }
}
