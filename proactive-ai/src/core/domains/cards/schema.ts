import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const generatedIntentCards = sqliteTable("generated_intent_cards", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  cardId: text("card_id").notNull(),
  goalBasket: text("goal_basket").notNull(),
  title: text("title").notNull(),
  titleKey: text("title_key").notNull(),
  whyNow: text("why_now").notNull(),
  summary: text("summary").notNull(),
  primaryActionLabel: text("primary_action_label").notNull(),
  sources: text("sources_json", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  generatedAt: text("generated_at").notNull(),
  metadata: text("metadata_json", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type GeneratedIntentCardRow = typeof generatedIntentCards.$inferSelect;
export type NewGeneratedIntentCardRow = typeof generatedIntentCards.$inferInsert;
