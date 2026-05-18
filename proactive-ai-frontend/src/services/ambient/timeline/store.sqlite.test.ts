import { beforeEach, describe, expect, test, vi } from "vitest";

import { SqliteTimelineStore } from "./store";

const sqliteMock = vi.hoisted(() => {
  const conn = {
    open: vi.fn(async () => {}),
    isDBOpen: vi.fn(async () => ({ result: true })),
    execute: vi.fn(async () => ({})),
    run: vi.fn(async () => ({ changes: { changes: 0 } })),
    query: vi.fn(async (_sql?: string) => ({ values: [] as Record<string, unknown>[] })),
  };
  const factory = {
    isConnection: vi.fn(async () => ({ result: false })),
    createConnection: vi.fn(async () => conn),
    retrieveConnection: vi.fn(async () => conn),
  };
  return { conn, factory };
});

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: { __raw: true },
  SQLiteConnection: vi.fn(() => sqliteMock.factory),
}));

describe("SqliteTimelineStore migrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqliteMock.factory.isConnection.mockResolvedValue({ result: false });
    sqliteMock.factory.createConnection.mockResolvedValue(sqliteMock.conn);
    sqliteMock.conn.isDBOpen.mockResolvedValue({ result: true });
    sqliteMock.conn.query.mockResolvedValue({ values: [] });
  });

  test("adds retry metadata columns to existing candidate window tables", async () => {
    sqliteMock.conn.query.mockImplementation(async (sql?: string) => {
      if ((sql ?? "").startsWith("PRAGMA table_info(ambient_candidate_windows)")) {
        return {
          values: [
            { name: "id" },
            { name: "status" },
            { name: "expires_at" },
          ],
        };
      }
      return { values: [] };
    });

    await new SqliteTimelineStore().init();

    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "ALTER TABLE ambient_candidate_windows ADD COLUMN last_attempt_at TEXT",
    );
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "ALTER TABLE ambient_candidate_windows ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
    );
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "ALTER TABLE ambient_candidate_windows ADD COLUMN last_error_code TEXT",
    );
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'pending'",
    );
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_error_message TEXT",
    );
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "ALTER TABLE ambient_timeline_events ADD COLUMN generation_source TEXT",
    );
  });

  test("does not alter candidate window tables that already have retry metadata", async () => {
    sqliteMock.conn.query.mockImplementation(async (sql?: string) => {
      if ((sql ?? "").startsWith("PRAGMA table_info(ambient_candidate_windows)")) {
        return {
          values: [
            { name: "id" },
            { name: "last_attempt_at" },
            { name: "attempt_count" },
            { name: "last_error_code" },
            { name: "summary_status" },
            { name: "summary_run_id" },
            { name: "summary_processing_expires_at" },
            { name: "summary_error_code" },
            { name: "summary_error_message" },
          ],
        };
      }
      if ((sql ?? "").startsWith("PRAGMA table_info(ambient_timeline_events)")) {
        return {
          values: [
            { name: "id" },
            { name: "generation_source" },
            { name: "summary_run_id" },
            { name: "source_window_ids_json" },
            { name: "llm_model_id" },
            { name: "llm_generated_at" },
            { name: "llm_updated_at" },
            { name: "idempotency_key" },
          ],
        };
      }
      if ((sql ?? "").includes("FROM ambient_timeline_meta")) {
        return { values: [{ value: "done" }] };
      }
      return { values: [] };
    });

    await new SqliteTimelineStore().init();

    expect(sqliteMock.conn.run).not.toHaveBeenCalled();
  });

  test("cleans transcript segment labels from existing sqlite timeline rows", async () => {
    sqliteMock.conn.query.mockImplementation(async (sql?: string) => {
      if ((sql ?? "").startsWith("PRAGMA table_info(ambient_candidate_windows)")) {
        return {
          values: [
            { name: "id" },
            { name: "last_attempt_at" },
            { name: "attempt_count" },
            { name: "last_error_code" },
            { name: "summary_status" },
            { name: "summary_run_id" },
            { name: "summary_processing_expires_at" },
            { name: "summary_error_code" },
            { name: "summary_error_message" },
          ],
        };
      }
      if ((sql ?? "").startsWith("PRAGMA table_info(ambient_timeline_events)")) {
        return {
          values: [
            { name: "id" },
            { name: "generation_source" },
            { name: "summary_run_id" },
            { name: "source_window_ids_json" },
            { name: "llm_model_id" },
            { name: "llm_generated_at" },
            { name: "llm_updated_at" },
            { name: "idempotency_key" },
          ],
        };
      }
      if ((sql ?? "").includes("FROM ambient_timeline_meta")) {
        return { values: [] };
      }
      return { values: [] };
    });

    await new SqliteTimelineStore().init();

    expect(sqliteMock.conn.run).toHaveBeenCalledWith(expect.stringContaining(
      "UPDATE ambient_raw_events",
    ));
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(expect.stringContaining(
      "UPDATE ambient_candidate_windows",
    ));
    expect(sqliteMock.conn.run).toHaveBeenCalledWith(
      "INSERT OR REPLACE INTO ambient_timeline_meta (key, value) VALUES (?, ?)",
      ["transcript_segment_label_cleanup_v1", "done"],
    );
  });

  test("queries raw events by refs and time range", async () => {
    sqliteMock.conn.query.mockImplementation(async (sql?: string) => {
      if ((sql ?? "").includes("FROM ambient_raw_events") && (sql ?? "").includes("id IN")) {
        return { values: [rawRow({ id: "raw_1", source_type: "transcript" })] };
      }
      if ((sql ?? "").includes("occurred_at <= ?") && (sql ?? "").includes("COALESCE(ended_at, occurred_at) >= ?")) {
        return { values: [rawRow({ id: "raw_2", source_type: "location" })] };
      }
      return { values: [] };
    });
    const store = new SqliteTimelineStore();

    const byRefs = await store.getRawEventsByRefs([{ sourceType: "transcript", id: "raw_1" }]);
    const inRange = await store.listRawEventsInRange({
      localDate: "2026-05-15",
      sourceType: "location",
      start: "2026-05-15T10:00:00.000Z",
      end: "2026-05-15T10:10:00.000Z",
      limit: 5,
    });

    expect(byRefs[0]?.id).toBe("raw_1");
    expect(inRange[0]?.id).toBe("raw_2");
  });
});

function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "raw",
    local_user_id: "local",
    device_id: "device",
    source_type: "health",
    event_type: "health.summary",
    source_version: "v1",
    occurred_at: "2026-05-15T10:00:00.000Z",
    ended_at: null,
    collected_at: "2026-05-15T10:00:01.000Z",
    timezone: "UTC",
    local_date: "2026-05-15",
    payload_json: JSON.stringify({ metric: "steps" }),
    compact_text: "compact",
    confidence: null,
    sensitivity: "normal",
    permission_state: null,
    ttl_expires_at: null,
    content_hash: "hash",
    dedupe_key: "dedupe",
    processing_status: "new",
    created_at: "2026-05-15T10:00:01.000Z",
    updated_at: "2026-05-15T10:00:01.000Z",
    ...overrides,
  };
}
