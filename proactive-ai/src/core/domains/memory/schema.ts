import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const memoryEvents = sqliteTable("memory_events", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull(),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectKey: text("subject_key").notNull(),
  text: text("text").notNull(),
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  confidence: real("confidence").notNull().$defaultFn(() => 1),
  occurredAt: text("occurred_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const memoryEntries = sqliteTable("memory_entries", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull(),
  category: text("category").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull().$defaultFn(() => "active"),
  score: real("score").notNull().$defaultFn(() => 0),
  evidenceCount: integer("evidence_count").notNull().$defaultFn(() => 0),
  sourceEventIds: text("source_event_ids", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  lastConfirmedAt: text("last_confirmed_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type MemoryEventRecord = typeof memoryEvents.$inferSelect;
export type NewMemoryEventRecord = typeof memoryEvents.$inferInsert;

export type MemoryEntryRecord = typeof memoryEntries.$inferSelect;
export type NewMemoryEntryRecord = typeof memoryEntries.$inferInsert;
