import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const worldItems = sqliteTable("world_items", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  normalizedUrl: text("normalized_url").notNull().unique(),
  externalId: text("external_id"),
  summary: text("summary"),
  publishedAt: text("published_at"),
  searchQueries: text("search_queries", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type WorldItemRecord = typeof worldItems.$inferSelect;
export type NewWorldItemRecord = typeof worldItems.$inferInsert;
