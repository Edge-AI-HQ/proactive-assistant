#!/usr/bin/env node
/**
 * Run all pending database migrations in order.
 *
 * 1. Ensures the `schema_migrations` table exists (idempotent).
 * 2. Reads which migrations have already been applied.
 * 3. Scans apis/db/migrations/ for NNN_*.sql files.
 * 4. Executes any that haven't been applied yet, in numeric order.
 *
 * Usage (via fly.toml release_command):
 *   dotenvx run -f .env.${DEPLOY_ENV} -- node scripts/run-all-migrations.mjs
 *
 * Usage (local):
 *   cd apis && node scripts/run-all-migrations.mjs
 */

import "dotenv/config";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "db", "migrations");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || !dbUrl.startsWith("postgres")) {
  console.error("SUPABASE_DB_URL is required and must be a postgres URL");
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });

try {
  await client.connect();

  // 1. Ensure tracking table exists (idempotent, covers first-ever run)
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      number     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Get already-applied migration numbers
  const { rows: applied } = await client.query(
    "SELECT number FROM schema_migrations"
  );
  const appliedSet = new Set(applied.map((r) => r.number));

  // 3. Scan migration files — pattern: NNN_name.sql
  const files = await readdir(migrationsDir);
  const migrations = files
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((f) => {
      const number = f.slice(0, 3);
      const name = f.slice(4).replace(/\.sql$/, "");
      return { number, name, file: f };
    });

  // 4. Run pending migrations in order
  const pending = migrations.filter((m) => !appliedSet.has(m.number));

  if (pending.length === 0) {
    console.log("[migrate] All migrations already applied.");
  } else {
    console.log(`[migrate] ${pending.length} pending migration(s) to apply.`);
  }

  for (const m of pending) {
    const sql = await readFile(join(migrationsDir, m.file), "utf8");
    console.log(`[migrate] Applying ${m.file} ...`);
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (number, name) VALUES ($1, $2)",
      [m.number, m.name]
    );
    console.log(`[migrate] Applied ${m.file}`);
  }

  console.log("[migrate] Done.");
} catch (err) {
  console.error("[migrate] Migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
