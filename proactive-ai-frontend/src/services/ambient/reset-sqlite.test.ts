import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearAmbientSqliteData } from "./reset-sqlite";

const { sqliteFactoryMock, dbConnectionMock } = vi.hoisted(() => ({
  sqliteFactoryMock: {
    isConnection: vi.fn(),
    closeConnection: vi.fn(),
    isDatabase: vi.fn(),
    createConnection: vi.fn(),
    retrieveConnection: vi.fn(),
  },
  dbConnectionMock: {
    open: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: { __raw: true },
  SQLiteConnection: vi.fn(() => sqliteFactoryMock),
}));

describe("clearAmbientSqliteData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqliteFactoryMock.isConnection.mockResolvedValue({ result: true });
    sqliteFactoryMock.closeConnection.mockResolvedValue(undefined);
    sqliteFactoryMock.isDatabase.mockResolvedValue({ result: true });
    sqliteFactoryMock.createConnection.mockResolvedValue(dbConnectionMock);
    sqliteFactoryMock.retrieveConnection.mockResolvedValue(dbConnectionMock);
    dbConnectionMock.open.mockResolvedValue(undefined);
    dbConnectionMock.delete.mockResolvedValue(undefined);
    dbConnectionMock.execute.mockResolvedValue(undefined);
  });

  test("closes open Ambient SQLite connections and deletes both databases", async () => {
    await clearAmbientSqliteData();

    expect(sqliteFactoryMock.isConnection).toHaveBeenCalledWith("pin_ambient_timeline", false);
    expect(sqliteFactoryMock.isConnection).toHaveBeenCalledWith("pin_ambient_outbox", false);
    expect(sqliteFactoryMock.closeConnection).toHaveBeenCalledWith("pin_ambient_timeline", false);
    expect(sqliteFactoryMock.closeConnection).toHaveBeenCalledWith("pin_ambient_outbox", false);
    expect(sqliteFactoryMock.isDatabase).toHaveBeenCalledWith("pin_ambient_timeline");
    expect(sqliteFactoryMock.isDatabase).toHaveBeenCalledWith("pin_ambient_outbox");
    expect(sqliteFactoryMock.createConnection).toHaveBeenCalledWith("pin_ambient_timeline", false, "no-encryption", 1, false);
    expect(sqliteFactoryMock.createConnection).toHaveBeenCalledWith("pin_ambient_outbox", false, "no-encryption", 1, false);
    expect(dbConnectionMock.delete).toHaveBeenCalledTimes(2);
  });


  test("reuses an existing connection when createConnection reports it already exists", async () => {
    sqliteFactoryMock.isConnection.mockResolvedValue({ result: false });
    sqliteFactoryMock.createConnection.mockRejectedValueOnce(
      new Error("CreateConnection: Connection pin_ambient_timeline already exists"),
    );

    await clearAmbientSqliteData();

    expect(sqliteFactoryMock.retrieveConnection).toHaveBeenCalledWith("pin_ambient_timeline", false);
    expect(dbConnectionMock.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM ambient_raw_events"));
  });

  test("purges Ambient tables before deleting so stale rows are gone even if file deletion is ineffective", async () => {
    await clearAmbientSqliteData();

    expect(dbConnectionMock.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM ambient_raw_events"));
    expect(dbConnectionMock.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM ambient_outbox"));
  });

  test("does not run VACUUM because the plugin wraps execute calls in transactions", async () => {
    await clearAmbientSqliteData();

    const executedSql = dbConnectionMock.execute.mock.calls.map(([sql]) => String(sql));
    expect(executedSql.some((sql) => sql.includes("VACUUM"))).toBe(false);
  });
});
