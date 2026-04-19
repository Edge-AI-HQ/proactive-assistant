import { eq, and, gte, desc } from "drizzle-orm";

import type { SqliteDatabase } from "../../db/sqlite_adapter.js";
import {
  feedbackEvents,
  type FeedbackEventRecord,
  type NewFeedbackEventRecord,
} from "./schema.js";

export interface CreateFeedbackInput {
  pushId?: string;
  intentCardId?: string;
  intentKey?: string;
  conversationId?: string;
  messageId?: string;
  kind: string;
  action?: string;
  source?: string;
  basket?: string;
  channel?: string;
  value?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ListFeedbackInput {
  since?: string;
  kind?: string;
  action?: string;
  source?: string;
  basket?: string;
  channel?: string;
  pushId?: string;
  intentCardId?: string;
  limit: number;
}

export interface FeedbackStats {
  grossHitCount: number;
  qualifiedHitCount: number;
  totalCount: number;
  kindDistribution: Record<string, number>;
  actionDistribution: Record<string, number>;
  basketDistribution: Record<string, number>;
  sourceDistribution: Record<string, number>;
}

export interface StatsInput {
  since?: string;
  basket?: string;
  channel?: string;
}

const nextId = (): string =>
  `fe_${Math.random().toString(36).slice(2, 10)}`;

export class FeedbackRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async create(input: CreateFeedbackInput): Promise<FeedbackEventRecord> {
    await this.ensureSchema();

    const id = nextId();
    const now = input.createdAt ?? new Date().toISOString();

    const values: NewFeedbackEventRecord = {
      id,
      pushId: input.pushId ?? null,
      intentCardId: input.intentCardId ?? null,
      intentKey: input.intentKey ?? null,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      kind: input.kind,
      action: input.action ?? null,
      source: input.source ?? null,
      basket: input.basket ?? null,
      channel: input.channel ?? null,
      value: input.value ?? null,
      text: input.text ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
    };

    this.database.orm.insert(feedbackEvents).values(values).run();
    return (await this.getById(id)) as FeedbackEventRecord;
  }

  async getById(id: string): Promise<FeedbackEventRecord | null> {
    await this.ensureSchema();
    const result = this.database.orm
      .select()
      .from(feedbackEvents)
      .where(eq(feedbackEvents.id, id))
      .limit(1)
      .all();

    return result[0] ?? null;
  }

  async list(input: ListFeedbackInput): Promise<FeedbackEventRecord[]> {
    await this.ensureSchema();

    const conditions = [];

    if (input.since) {
      conditions.push(gte(feedbackEvents.createdAt, input.since));
    }
    if (input.kind) {
      conditions.push(eq(feedbackEvents.kind, input.kind));
    }
    if (input.action) {
      conditions.push(eq(feedbackEvents.action, input.action));
    }
    if (input.source) {
      conditions.push(eq(feedbackEvents.source, input.source));
    }
    if (input.basket) {
      conditions.push(eq(feedbackEvents.basket, input.basket));
    }
    if (input.channel) {
      conditions.push(eq(feedbackEvents.channel, input.channel));
    }
    if (input.pushId) {
      conditions.push(eq(feedbackEvents.pushId, input.pushId));
    }
    if (input.intentCardId) {
      conditions.push(eq(feedbackEvents.intentCardId, input.intentCardId));
    }

    const query = this.database.orm
      .select()
      .from(feedbackEvents)
      .orderBy(desc(feedbackEvents.createdAt))
      .limit(input.limit);

    if (conditions.length > 0) {
      return query.where(and(...conditions)).all();
    }

    return query.all();
  }

  async stats(input: StatsInput): Promise<FeedbackStats> {
    await this.ensureSchema();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (input.since) {
      conditions.push("created_at >= ?");
      params.push(input.since);
    }
    if (input.basket) {
      conditions.push("basket = ?");
      params.push(input.basket);
    }
    if (input.channel) {
      conditions.push("channel = ?");
      params.push(input.channel);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.database.all<{
      kind: string;
      action: string | null;
      source: string | null;
      basket: string | null;
      cnt: number;
    }>(
      `SELECT kind, action, source, basket, COUNT(*) as cnt
       FROM feedback_events ${whereClause}
       GROUP BY kind, action, source, basket`,
      params,
    );

    let totalCount = 0;
    let grossHitCount = 0;
    let qualifiedHitCount = 0;
    const kindDistribution: Record<string, number> = {};
    const actionDistribution: Record<string, number> = {};
    const basketDistribution: Record<string, number> = {};
    const sourceDistribution: Record<string, number> = {};

    for (const row of rows) {
      totalCount += row.cnt;

      kindDistribution[row.kind] =
        (kindDistribution[row.kind] ?? 0) + row.cnt;

      if (row.action) {
        actionDistribution[row.action] =
          (actionDistribution[row.action] ?? 0) + row.cnt;
      }

      if (row.basket) {
        basketDistribution[row.basket] =
          (basketDistribution[row.basket] ?? 0) + row.cnt;
      }

      if (row.source) {
        sourceDistribution[row.source] =
          (sourceDistribution[row.source] ?? 0) + row.cnt;
      }

      // Gross Hit: card_open + card_action(*) + explicit_rating(thumbs_up)
      if (
        row.kind === "card_open" ||
        row.kind === "card_action" ||
        (row.kind === "explicit_rating" && row.action === "thumbs_up")
      ) {
        grossHitCount += row.cnt;
      }

      // Qualified Hit: card_action(confirm) + explicit_rating(thumbs_up)
      if (
        (row.kind === "card_action" && row.action === "confirm") ||
        (row.kind === "explicit_rating" && row.action === "thumbs_up")
      ) {
        qualifiedHitCount += row.cnt;
      }
    }

    return {
      grossHitCount,
      qualifiedHitCount,
      totalCount,
      kindDistribution,
      actionDistribution,
      basketDistribution,
      sourceDistribution,
    };
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS feedback_events (
        id              TEXT PRIMARY KEY NOT NULL,
        push_id         TEXT,
        intent_card_id  TEXT,
        intent_key      TEXT,
        conversation_id TEXT,
        message_id      TEXT,
        kind            TEXT NOT NULL,
        action          TEXT,
        source          TEXT,
        basket          TEXT,
        channel         TEXT,
        value           TEXT,
        text            TEXT,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      )
    `);

    const columns = this.database.all<{ name: string }>(
      `PRAGMA table_info(feedback_events)`,
    );
    if (!columns.some((entry) => entry.name === "intent_key")) {
      this.database.exec(`ALTER TABLE feedback_events ADD COLUMN intent_key TEXT`);
    }

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_feedback_events_intent_key
        ON feedback_events(intent_key)
    `);

    this.schemaReady = true;
  }
}
