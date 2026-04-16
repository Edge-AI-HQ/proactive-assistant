import { and, desc, eq, gte } from "drizzle-orm";

import type { SqliteDatabase } from "../../db/sqlite_adapter.js";
import {
  generatedIntentCards,
  type GeneratedIntentCardRow,
  type NewGeneratedIntentCardRow,
} from "./schema.js";

export interface GeneratedIntentCardInput {
  cardId: string;
  goalBasket: string;
  title: string;
  titleKey: string;
  whyNow: string;
  summary: string;
  primaryActionLabel: string;
  sources: string[];
  metadata?: Record<string, unknown>;
}

export interface RecordGeneratedBatchInput {
  runId: string;
  generatedAt: string;
  cards: GeneratedIntentCardInput[];
}

export interface ListRecentGeneratedCardsInput {
  limit: number;
  basket?: string;
  since?: string;
}

const nextId = (): string => `gic_${Math.random().toString(36).slice(2, 10)}`;

export class GeneratedIntentCardRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async recordBatch(
    input: RecordGeneratedBatchInput,
  ): Promise<GeneratedIntentCardRow[]> {
    await this.ensureSchema();

    const rows: GeneratedIntentCardRow[] = [];
    for (const card of input.cards) {
      const values: NewGeneratedIntentCardRow = {
        id: nextId(),
        runId: input.runId,
        cardId: card.cardId,
        goalBasket: card.goalBasket,
        title: card.title,
        titleKey: card.titleKey,
        whyNow: card.whyNow,
        summary: card.summary,
        primaryActionLabel: card.primaryActionLabel,
        sources: card.sources,
        generatedAt: input.generatedAt,
        metadata: card.metadata ?? {},
        createdAt: new Date().toISOString(),
      };

      this.database.orm.insert(generatedIntentCards).values(values).run();
      rows.push(values as GeneratedIntentCardRow);
    }

    return rows;
  }

  async listRecent(
    input: ListRecentGeneratedCardsInput,
  ): Promise<GeneratedIntentCardRow[]> {
    await this.ensureSchema();

    const conditions = [];
    if (input.basket) {
      conditions.push(eq(generatedIntentCards.goalBasket, input.basket));
    }
    if (input.since) {
      conditions.push(gte(generatedIntentCards.generatedAt, input.since));
    }

    const query = this.database.orm
      .select()
      .from(generatedIntentCards)
      .orderBy(
        desc(generatedIntentCards.generatedAt),
        desc(generatedIntentCards.createdAt),
        desc(generatedIntentCards.cardId),
      )
      .limit(input.limit);

    if (conditions.length > 0) {
      return query.where(and(...conditions)).all();
    }

    return query.all();
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS generated_intent_cards (
        id                    TEXT PRIMARY KEY NOT NULL,
        run_id                TEXT NOT NULL,
        card_id               TEXT NOT NULL,
        goal_basket           TEXT NOT NULL,
        title                 TEXT NOT NULL,
        title_key             TEXT NOT NULL,
        why_now               TEXT NOT NULL,
        summary               TEXT NOT NULL,
        primary_action_label  TEXT NOT NULL,
        sources_json          TEXT NOT NULL DEFAULT '[]',
        generated_at          TEXT NOT NULL,
        metadata_json         TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL
      )
    `);

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_generated_intent_cards_generated_at
        ON generated_intent_cards(generated_at DESC)
    `);

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_generated_intent_cards_goal_basket
        ON generated_intent_cards(goal_basket)
    `);

    this.schemaReady = true;
  }
}
