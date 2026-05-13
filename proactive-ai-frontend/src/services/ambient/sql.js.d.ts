// Minimal local typing for sql.js v1.x. We only use the subset wired
// into outbox.sqlite.test.ts. Avoid pulling @types/sql.js because the
// lockfile registry has resolution conflicts for unrelated transitive
// pins (see README troubleshooting). Drop this file if @types/sql.js
// ever lands in package.json.

declare module "sql.js" {
  export interface Statement {
    bind(values: unknown[]): void;
    step(): boolean;
    free(): void;
    getAsObject(): Record<string, unknown>;
  }

  export class Database {
    constructor();
    exec(sql: string): unknown;
    prepare(sql: string): Statement;
    getRowsModified(): number;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
