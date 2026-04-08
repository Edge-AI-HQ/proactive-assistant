import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const proactiveIngestCursor = sqliteTable("proactive_ingest_cursor", {
  source: text("source").primaryKey(),
  cursor: text("cursor"),
  updatedAt: text("updated_at").notNull(),
});

export const proactivePending = sqliteTable("proactive_pending", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  availableAt: text("available_at").notNull(),
  status: text("status").notNull(),
  processedAt: text("processed_at"),
});

export const proactiveLoopState = sqliteTable("proactive_loop_state", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: text("updated_at").notNull(),
});

export const proactiveContextRuns = sqliteTable("proactive_context_runs", {
  runToken: text("run_token").primaryKey(),
  itemIdsJson: text("item_ids_json").notNull(),
  itemCount: integer("item_count").notNull(),
  createdAt: text("created_at").notNull(),
  status: text("status").notNull(),
  committedAt: text("committed_at"),
});
