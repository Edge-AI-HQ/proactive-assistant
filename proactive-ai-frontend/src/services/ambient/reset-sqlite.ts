const AMBIENT_DATABASES = [
  {
    name: "pin_ambient_timeline",
    purgeSql: `
      DELETE FROM ambient_timeline_events;
      DELETE FROM ambient_candidate_windows;
      DELETE FROM ambient_raw_events;
    `,
  },
  {
    name: "pin_ambient_outbox",
    purgeSql: `
      DELETE FROM ambient_outbox;
    `,
  },
] as const;

interface SqliteDbConnection {
  open(): Promise<void>;
  isDBOpen?(): Promise<{ result?: boolean }>;
  execute(sql: string): Promise<unknown>;
  delete(): Promise<void>;
}

interface SqliteConnectionFactory {
  isConnection(dbName: string, readonly: boolean): Promise<{ result?: boolean }>;
  closeConnection(dbName: string, readonly: boolean): Promise<void>;
  isDatabase(dbName: string): Promise<{ result?: boolean }>;
  createConnection(
    dbName: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SqliteDbConnection>;
  retrieveConnection(dbName: string, readonly: boolean): Promise<SqliteDbConnection>;
}

interface SqliteModule {
  CapacitorSQLite?: unknown;
  SQLiteConnection?: new (sqlite: unknown) => SqliteConnectionFactory;
}

export async function clearAmbientSqliteData(): Promise<void> {
  const mod = await import("@capacitor-community/sqlite") as unknown as SqliteModule;
  if (!mod.CapacitorSQLite || !mod.SQLiteConnection) {
    throw new Error("@capacitor-community/sqlite plugin not available");
  }

  const sqlite = new mod.SQLiteConnection(mod.CapacitorSQLite);
  for (const db of AMBIENT_DATABASES) {
    const existingConnection = await sqlite
      .isConnection(db.name, false)
      .catch(() => ({ result: false }));
    if (existingConnection.result) {
      await sqlite.closeConnection(db.name, false);
    }

    const existingDatabase = await sqlite
      .isDatabase(db.name)
      .catch(() => ({ result: false }));
    if (!existingDatabase.result) continue;

    const conn = await openWritableConnection(sqlite, db.name);
    await conn.execute(db.purgeSql);
    await conn.delete();
  }
}

async function openWritableConnection(
  sqlite: SqliteConnectionFactory,
  dbName: string,
): Promise<SqliteDbConnection> {
  let conn: SqliteDbConnection;
  try {
    conn = await sqlite.createConnection(dbName, false, "no-encryption", 1, false);
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    conn = await sqlite.retrieveConnection(dbName, false);
  }

  const open = await conn.isDBOpen?.().catch(() => ({ result: false }));
  if (open?.result !== true) {
    await conn.open();
  }
  return conn;
}

function isAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("already exists");
}
