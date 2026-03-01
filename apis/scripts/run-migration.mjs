#!/usr/bin/env node
/**
 * 执行单次数据库迁移（本地或 Fly 上）。
 * 使用环境变量 SUPABASE_DB_URL；本地可在 apis 下放 .env 或传环境变量。
 *
 * 用法: cd apis && node scripts/run-migration.mjs 012
 *       npm run db:migrate -- 012
 */

import "dotenv/config";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const migrationNumber = process.argv[2];
if (!migrationNumber || !/^\d{3}$/.test(migrationNumber)) {
  console.error("Usage: node run-migration.mjs <NNN>   e.g. 012");
  process.exit(1);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || !dbUrl.startsWith("postgres")) {
  console.error("SUPABASE_DB_URL is required and must be a postgres URL");
  process.exit(1);
}

const migrationsDir = join(__dirname, "..", "db", "migrations");
const prefix = `${migrationNumber}_`;
let sqlPath;
try {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(migrationsDir);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".sql"));
  if (!match) {
    console.error(`No migration file found for ${migrationNumber} in db/migrations/`);
    process.exit(1);
  }
  sqlPath = join(migrationsDir, match);
} catch (err) {
  console.error("Migrations dir read failed:", err.message);
  process.exit(1);
}

const sql = await readFile(sqlPath, "utf8");

const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  await client.query(sql);
  console.log(`Migration ${migrationNumber} applied: ${sqlPath.split("/").pop()}`);
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
