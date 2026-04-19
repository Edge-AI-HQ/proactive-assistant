import type { SqliteDatabase } from "../../db/sqlite_adapter.js";

import type {
  IntentCardStateRow,
  IntentThreadStateRow,
} from "./schema.js";

export interface UpsertIntentCardStateInput {
  cardId: string;
  intentKey: string;
  goalBasket: string;
  latestOutcome: string;
  outcomeAt?: string | null;
  hasDeepChat: boolean;
  latestChatDecision: string;
  latestChatSummary?: string | null;
  nextAngles: string[];
  updatedAt: string;
}

export interface UpsertIntentThreadStateInput {
  intentKey: string;
  goalBasket: string;
  latestCardId?: string | null;
  latestGeneratedAt?: string | null;
  latestCardOutcome: string;
  hasAnyConfirmedCard: boolean;
  hasAnyDismissedCard: boolean;
  latestChatDecision: string;
  latestChatSummary?: string | null;
  nextAngles: string[];
  threadDecision: string;
  updatedAt: string;
}

export class IntentStateRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  getCardState(cardId: string): IntentCardStateRow | null {
    this.ensureSchema();
    return this.database.get<IntentCardStateRow>(
      `SELECT
        card_id AS cardId,
        intent_key AS intentKey,
        goal_basket AS goalBasket,
        latest_outcome AS latestOutcome,
        outcome_at AS outcomeAt,
        has_deep_chat AS hasDeepChat,
        latest_chat_decision AS latestChatDecision,
        latest_chat_summary AS latestChatSummary,
        next_angles_json AS nextAngles,
        updated_at AS updatedAt
      FROM intent_card_state
      WHERE card_id = ?
      LIMIT 1`,
      [cardId],
    ) ?? null;
  }

  getThreadState(intentKey: string): IntentThreadStateRow | null {
    this.ensureSchema();
    return this.database.get<IntentThreadStateRow>(
      `SELECT
        intent_key AS intentKey,
        goal_basket AS goalBasket,
        latest_card_id AS latestCardId,
        latest_generated_at AS latestGeneratedAt,
        latest_card_outcome AS latestCardOutcome,
        has_any_confirmed_card AS hasAnyConfirmedCard,
        has_any_dismissed_card AS hasAnyDismissedCard,
        latest_chat_decision AS latestChatDecision,
        latest_chat_summary AS latestChatSummary,
        next_angles_json AS nextAngles,
        thread_decision AS threadDecision,
        updated_at AS updatedAt
      FROM intent_thread_state
      WHERE intent_key = ?
      LIMIT 1`,
      [intentKey],
    ) ?? null;
  }

  listThreadStates(intentKeys: string[]): IntentThreadStateRow[] {
    this.ensureSchema();
    if (intentKeys.length === 0) return [];
    const placeholders = intentKeys.map(() => "?").join(", ");
    return this.database.all<IntentThreadStateRow>(
      `SELECT
        intent_key AS intentKey,
        goal_basket AS goalBasket,
        latest_card_id AS latestCardId,
        latest_generated_at AS latestGeneratedAt,
        latest_card_outcome AS latestCardOutcome,
        has_any_confirmed_card AS hasAnyConfirmedCard,
        has_any_dismissed_card AS hasAnyDismissedCard,
        latest_chat_decision AS latestChatDecision,
        latest_chat_summary AS latestChatSummary,
        next_angles_json AS nextAngles,
        thread_decision AS threadDecision,
        updated_at AS updatedAt
      FROM intent_thread_state
      WHERE intent_key IN (${placeholders})`,
      intentKeys,
    );
  }

  upsertCardState(input: UpsertIntentCardStateInput): void {
    this.ensureSchema();
    this.database.exec(
      `INSERT INTO intent_card_state (
        card_id, intent_key, goal_basket, latest_outcome, outcome_at, has_deep_chat,
        latest_chat_decision, latest_chat_summary, next_angles_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET
        intent_key = excluded.intent_key,
        goal_basket = excluded.goal_basket,
        latest_outcome = excluded.latest_outcome,
        outcome_at = excluded.outcome_at,
        has_deep_chat = excluded.has_deep_chat,
        latest_chat_decision = excluded.latest_chat_decision,
        latest_chat_summary = excluded.latest_chat_summary,
        next_angles_json = excluded.next_angles_json,
        updated_at = excluded.updated_at`,
      [
        input.cardId,
        input.intentKey,
        input.goalBasket,
        input.latestOutcome,
        input.outcomeAt ?? null,
        input.hasDeepChat ? 1 : 0,
        input.latestChatDecision,
        input.latestChatSummary ?? null,
        JSON.stringify(input.nextAngles),
        input.updatedAt,
      ],
    );
  }

  upsertThreadState(input: UpsertIntentThreadStateInput): void {
    this.ensureSchema();
    this.database.exec(
      `INSERT INTO intent_thread_state (
        intent_key, goal_basket, latest_card_id, latest_generated_at, latest_card_outcome,
        has_any_confirmed_card, has_any_dismissed_card, latest_chat_decision,
        latest_chat_summary, next_angles_json, thread_decision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_key) DO UPDATE SET
        goal_basket = excluded.goal_basket,
        latest_card_id = excluded.latest_card_id,
        latest_generated_at = excluded.latest_generated_at,
        latest_card_outcome = excluded.latest_card_outcome,
        has_any_confirmed_card = excluded.has_any_confirmed_card,
        has_any_dismissed_card = excluded.has_any_dismissed_card,
        latest_chat_decision = excluded.latest_chat_decision,
        latest_chat_summary = excluded.latest_chat_summary,
        next_angles_json = excluded.next_angles_json,
        thread_decision = excluded.thread_decision,
        updated_at = excluded.updated_at`,
      [
        input.intentKey,
        input.goalBasket,
        input.latestCardId ?? null,
        input.latestGeneratedAt ?? null,
        input.latestCardOutcome,
        input.hasAnyConfirmedCard ? 1 : 0,
        input.hasAnyDismissedCard ? 1 : 0,
        input.latestChatDecision,
        input.latestChatSummary ?? null,
        JSON.stringify(input.nextAngles),
        input.threadDecision,
        input.updatedAt,
      ],
    );
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS intent_card_state (
        card_id               TEXT PRIMARY KEY NOT NULL,
        intent_key            TEXT NOT NULL,
        goal_basket           TEXT NOT NULL,
        latest_outcome        TEXT NOT NULL DEFAULT 'none',
        outcome_at            TEXT,
        has_deep_chat         INTEGER NOT NULL DEFAULT 0,
        latest_chat_decision  TEXT NOT NULL DEFAULT 'none',
        latest_chat_summary   TEXT,
        next_angles_json      TEXT NOT NULL DEFAULT '[]',
        updated_at            TEXT NOT NULL
      )
    `);

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS intent_thread_state (
        intent_key               TEXT PRIMARY KEY NOT NULL,
        goal_basket              TEXT NOT NULL,
        latest_card_id           TEXT,
        latest_generated_at      TEXT,
        latest_card_outcome      TEXT NOT NULL DEFAULT 'none',
        has_any_confirmed_card   INTEGER NOT NULL DEFAULT 0,
        has_any_dismissed_card   INTEGER NOT NULL DEFAULT 0,
        latest_chat_decision     TEXT NOT NULL DEFAULT 'none',
        latest_chat_summary      TEXT,
        next_angles_json         TEXT NOT NULL DEFAULT '[]',
        thread_decision          TEXT NOT NULL DEFAULT 'hold',
        updated_at               TEXT NOT NULL
      )
    `);

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_thread_state_updated_at
        ON intent_thread_state(updated_at DESC)
    `);
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_thread_state_goal_basket
        ON intent_thread_state(goal_basket)
    `);

    this.schemaReady = true;
  }
}
