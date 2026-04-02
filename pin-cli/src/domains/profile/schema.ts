import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  locale: text("locale"),
  timezone: text("timezone"),
  summary: text("summary"),
  facts: text("facts", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  preferences: text("preferences", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  memory: text("memory", { mode: "json" })
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .$defaultFn(() => []),
  goals: text("goals", { mode: "json" })
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .$defaultFn(() => []),
  constraints: text("constraints", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
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

export type ProfileRecord = typeof profiles.$inferSelect;
export type NewProfileRecord = typeof profiles.$inferInsert;
