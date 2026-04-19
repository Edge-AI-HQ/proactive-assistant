import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const intentCardState = sqliteTable("intent_card_state", {
  cardId: text("card_id").primaryKey(),
  intentKey: text("intent_key").notNull(),
  goalBasket: text("goal_basket").notNull(),
  latestOutcome: text("latest_outcome").notNull().$defaultFn(() => "none"),
  outcomeAt: text("outcome_at"),
  hasDeepChat: integer("has_deep_chat").notNull().$defaultFn(() => 0),
  latestChatDecision: text("latest_chat_decision").notNull().$defaultFn(() => "none"),
  latestChatSummary: text("latest_chat_summary"),
  nextAngles: text("next_angles_json", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const intentThreadState = sqliteTable("intent_thread_state", {
  intentKey: text("intent_key").primaryKey(),
  goalBasket: text("goal_basket").notNull(),
  latestCardId: text("latest_card_id"),
  latestGeneratedAt: text("latest_generated_at"),
  latestCardOutcome: text("latest_card_outcome").notNull().$defaultFn(() => "none"),
  hasAnyConfirmedCard: integer("has_any_confirmed_card").notNull().$defaultFn(() => 0),
  hasAnyDismissedCard: integer("has_any_dismissed_card").notNull().$defaultFn(() => 0),
  latestChatDecision: text("latest_chat_decision").notNull().$defaultFn(() => "none"),
  latestChatSummary: text("latest_chat_summary"),
  nextAngles: text("next_angles_json", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  threadDecision: text("thread_decision").notNull().$defaultFn(() => "hold"),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export type IntentCardStateRow = typeof intentCardState.$inferSelect;
export type NewIntentCardStateRow = typeof intentCardState.$inferInsert;
export type IntentThreadStateRow = typeof intentThreadState.$inferSelect;
export type NewIntentThreadStateRow = typeof intentThreadState.$inferInsert;
