import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const VALID_PUSH_KINDS = [
  "proactive_card",
  "notification",
  "digest",
] as const;

export type PushKind = (typeof VALID_PUSH_KINDS)[number];

export const VALID_PUSH_CHANNELS = [
  "telegram",
  "web",
  "mobile",
  "im",
] as const;

export type PushChannel = (typeof VALID_PUSH_CHANNELS)[number];

export const VALID_BASKETS = [
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
] as const;

export const VALID_OUTCOME_STATUSES = [
  "clicked",
  "dismissed",
  "ignored",
  "converted",
] as const;

export type OutcomeStatus = (typeof VALID_OUTCOME_STATUSES)[number];

export const pushRecords = sqliteTable("push_records", {
  id: text("id").primaryKey(),
  intentCardId: text("intent_card_id"),
  kind: text("kind").notNull(),
  basket: text("basket"),
  title: text("title").notNull(),
  channel: text("channel"),
  ref: text("ref"),
  reason: text("reason"),
  pushedAt: text("pushed_at").notNull(),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type PushRecordRow = typeof pushRecords.$inferSelect;
export type NewPushRecordRow = typeof pushRecords.$inferInsert;

export const pushOutcomes = sqliteTable("push_outcomes", {
  id: text("id").primaryKey(),
  pushId: text("push_id").notNull(),
  status: text("status").notNull(),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  recordedAt: text("recorded_at").notNull(),
});

export type PushOutcomeRow = typeof pushOutcomes.$inferSelect;
export type NewPushOutcomeRow = typeof pushOutcomes.$inferInsert;
