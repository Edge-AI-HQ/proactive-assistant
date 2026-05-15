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
          ],
        };
      }
      return { values: [] };
    });

    await new SqliteTimelineStore().init();

    expect(sqliteMock.conn.run).not.toHaveBeenCalled();
  });
});
