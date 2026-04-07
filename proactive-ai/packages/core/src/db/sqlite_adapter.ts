import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

const toPlainRow = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => toPlainRow(item)) as T;
  }

  if (value && typeof value === "object") {
    return { ...(value as Record<string, unknown>) } as T;
  }

  return value;
};

export class SqliteDatabase {
  readonly client: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;

  constructor(filename: string) {
    this.client = new Database(filename);
    this.orm = drizzle(this.client, {
      schema,
    });
  }

  exec(sql: string, params: unknown[] = []): void {
    if (params.length === 0) {
      this.client.exec(sql);
      return;
    }

    this.client.prepare(sql).run(...params);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    const row = this.client.prepare(sql).get(...params) as T | undefined;
    return row ? toPlainRow(row) : undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return toPlainRow(this.client.prepare(sql).all(...params) as T[]);
  }

  close(): void {
    this.client.close();
  }
}
