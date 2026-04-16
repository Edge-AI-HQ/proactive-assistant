import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const feedbackEvents = sqliteTable("feedback_events", {
  id: text("id").primaryKey(),
  pushId: text("push_id"),
  intentCardId: text("intent_card_id"),
  intentKey: text("intent_key"),
  conversationId: text("conversation_id"),
  messageId: text("message_id"),
  kind: text("kind").notNull(),
  action: text("action"),
  source: text("source"),
  basket: text("basket"),
  channel: text("channel"),
  value: text("value"),
  text: text("text"),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type FeedbackEventRecord = typeof feedbackEvents.$inferSelect;
export type NewFeedbackEventRecord = typeof feedbackEvents.$inferInsert;
