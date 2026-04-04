#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const REQUIRED_SCHEMA = {
  users: [
    "id",
    "telegram_user_id",
    "gateway_token",
    "litellm_user_id",
    "litellm_user_alias",
    "litellm_key_alias",
    "litellm_virtual_key",
    "litellm_key_last4",
    "litellm_spend_usd",
    "litellm_budget_usd",
    "litellm_budget_duration",
    "litellm_rpm_limit",
    "litellm_tpm_limit",
    "litellm_last_synced_at",
    "created_at",
    "updated_at",
    "last_active_at",
  ],
  assistants: [
    "id",
    "owner_user_id",
    "assistant_bot_id",
    "assistant_bot_token",
    "assistant_bot_username",
    "litellm_user_id",
    "litellm_key_alias",
    "litellm_virtual_key",
    "litellm_key_last4",
    "litellm_spend_usd",
    "litellm_budget_usd",
    "litellm_budget_duration",
    "litellm_rpm_limit",
    "litellm_tpm_limit",
    "litellm_last_synced_at",
    "created_at",
    "updated_at",
  ],
  runtime_instances: [
    "id",
    "owner_user_id",
    "assistant_id",
    "scope",
    "runtime_provider",
    "container_name",
    "runtime_ref",
    "host_port",
    "status",
    "metadata",
    "created_at",
    "updated_at",
  ],
  gateway_sessions: [
    "id",
    "user_id",
    "assistant_id",
    "session_token",
    "expires_at",
    "created_at",
  ],
  payment_sessions: [
    "id",
    "user_id",
    "assistant_id",
    "session_token",
    "plan_code",
    "used",
    "expires_at",
    "used_at",
    "created_at",
  ],
  billing_plans: [
    "plan_code",
    "display_name",
    "stripe_price_id",
    "currency",
    "price_cents_monthly",
    "daily_refresh_credits",
    "monthly_refresh_credits",
    "sort_order",
    "is_active",
    "metadata",
    "created_at",
    "updated_at",
  ],
  subscription_periods: [
    "id",
    "user_id",
    "assistant_id",
    "stripe_subscription_id",
    "stripe_customer_id",
    "stripe_invoice_id",
    "period_start",
    "period_end",
    "plan_id",
    "status",
    "cancel_at_period_end",
    "budget_applied_at",
    "created_at",
    "updated_at",
  ],
  payment_events: [
    "id",
    "user_id",
    "assistant_id",
    "stripe_event_id",
    "event_type",
    "amount",
    "currency",
    "status",
    "processing_status",
    "error_message",
    "raw_data",
    "processed_at",
    "created_at",
  ],
  stripe_subscription_event_watermarks: [
    "stripe_subscription_id",
    "last_event_created",
    "last_event_id",
    "updated_at",
  ],
  user_pending_actions: [
    "id",
    "user_id",
    "action_type",
    "expires_at",
    "created_at",
  ],
};

function usage() {
  console.log(`Usage:
  scripts/reset-and-setup.mjs [--from-migrations] [--migrations-dir <path>] [--db-url <url>] [--truncate-data] [--keep-data] [--truncate-only]

Reset Pinclaw DB data (public schema only), then ensure schema by applying all SQL migration files in order.
By default script truncates all public schema tables, keeps litellm schema untouched, and re-runs billing_plans seed SQL from migrations when empty.
After applying migrations, script verifies required tables/columns.

Options:
      --from-migrations       Reserved for compatibility (no-op).
      --migrations-dir <path> Migrations directory (default: apis/db/migrations).
      --db-url <url>          Optional override for Postgres URL.
                              By default, reads SUPABASE_DB_URL from apis/.env,
                              then falls back to process env SUPABASE_DB_URL.
      --truncate-data         Truncate all public tables before running migrations (default behavior).
      --keep-data             Skip truncation and only ensure schema/migrations.
      --truncate-only         Truncate all public tables and exit without migrations.
  -h, --help                  Show this help.

Examples:
  # Reset public data + ensure schema in current SUPABASE_DB_URL
  node scripts/reset-and-setup.mjs

  # Keep data and only ensure schema/migrations
  node scripts/reset-and-setup.mjs --keep-data

  # Custom migrations directory
  node scripts/reset-and-setup.mjs --migrations-dir apis/db/migrations`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readEnvValue(envFile, key) {
  if (!fs.existsSync(envFile)) return "";
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  let value = "";
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    value = match[1].trim();
  }
  if (!value) return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

function resolveDir(inputPath) {
  if (!inputPath) return "";
  const candidates = [
    path.resolve(process.cwd(), inputPath),
    path.resolve(ROOT_DIR, inputPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return "";
}

function extractSupabaseProjectRefFromUrl(dbUrl) {
  try {
    const parsed = new URL(dbUrl);
    const host = parsed.hostname.toLowerCase();
    const username = decodeURIComponent(parsed.username || "");

    if (host.startsWith("db.") && host.endsWith(".supabase.co")) {
      const parts = host.split(".");
      if (parts.length >= 4 && parts[1]) return parts[1];
    }

    if (host.endsWith(".pooler.supabase.com")) {
      const userParts = username.split(".");
      if (userParts.length >= 2 && userParts[1]) return userParts[1];
    }
  } catch {
    return "";
  }

  return "";
}

function resolveEnsureFiles(migrationsDir) {
  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => path.join(migrationsDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    fail(`No SQL migration files found in: ${migrationsDir}`);
  }

  return files;
}

const SKIPPABLE_MIGRATION_ERROR_RULES = [
  {
    file: "001_unified_schema.sql",
    code: "42703",
    patterns: [/column "assistant_bot_token" does not exist/i, /column "assistant_bot_username" does not exist/i],
  },
  {
    file: "002_litellm_identity_unification.sql",
    code: "42703",
    patterns: [/column "litellm_virtual_key_encrypted" .* does not exist/i],
  },
  {
    file: "002_litellm_identity_unification.sql",
    code: "42P01",
    patterns: [/relation "user_credit_wallets" does not exist/i],
  },
  {
    file: "003_user_litellm_shared_key.sql",
    code: "42703",
    patterns: [/column a\.litellm_virtual_key_encrypted does not exist/i],
  },
  {
    file: "007_payment_event_ordering.sql",
    code: "42P01",
    patterns: [/relation "user_subscriptions" does not exist/i],
  },
  {
    file: "008_fix_subscription_status.sql",
    code: "42P01",
    patterns: [/relation "user_subscriptions" does not exist/i],
  },
  {
    file: "008_remove_wallet_ledger_tables.sql",
    code: "42P01",
    patterns: [/relation "user_credit_wallets" does not exist/i],
  },
  {
    file: "010_remove_litellm_key_encryption.sql",
    code: "42703",
    patterns: [/column "litellm_virtual_key_encrypted" does not exist/i],
  },
];

function shouldSkipMigrationError(file, error) {
  const filename = path.basename(file);
  const message = String(error?.message || "");
  const code = String(error?.code || "");

  for (const rule of SKIPPABLE_MIGRATION_ERROR_RULES) {
    if (rule.file !== filename) continue;
    if (rule.code && rule.code !== code) continue;
    if (!rule.patterns.some((pattern) => pattern.test(message))) continue;
    return true;
  }

  return false;
}

async function loadSchemaSnapshot(client) {
  const tablesResult = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `,
  );

  const columnsResult = await client.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `,
  );

  const tables = new Set(
    tablesResult.rows.map((row) => String(row.table_name || "").trim()).filter(Boolean),
  );

  const columnsByTable = new Map();
  for (const row of columnsResult.rows) {
    const tableName = String(row.table_name || "").trim();
    const columnName = String(row.column_name || "").trim();
    if (!tableName || !columnName) continue;

    const columnSet = columnsByTable.get(tableName) || new Set();
    columnSet.add(columnName);
    columnsByTable.set(tableName, columnSet);
  }

  return { tables, columnsByTable };
}

function collectSchemaGaps(snapshot) {
  const missingTables = [];
  const missingColumns = [];

  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!snapshot.tables.has(table)) {
      missingTables.push(table);
      continue;
    }

    const existingColumns = snapshot.columnsByTable.get(table) || new Set();
    for (const column of requiredColumns) {
      if (!existingColumns.has(column)) {
        missingColumns.push(`${table}.${column}`);
      }
    }
  }

  return { missingTables, missingColumns };
}

function printGaps(gaps, title) {
  if (!gaps.missingTables.length && !gaps.missingColumns.length) return;

  console.log(title);

  if (gaps.missingTables.length) {
    console.log("  Missing tables:");
    for (const table of gaps.missingTables) {
      console.log(`    - ${table}`);
    }
  }

  if (gaps.missingColumns.length) {
    console.log("  Missing columns:");
    for (const column of gaps.missingColumns) {
      console.log(`    - ${column}`);
    }
  }
}

async function applySqlFiles(client, files) {
  const skippedFiles = [];
  for (const file of files) {
    const sql = fs.readFileSync(file, "utf8");
    console.log(`  -> ${file}`);
    try {
      await client.query(sql);
    } catch (error) {
      if (!shouldSkipMigrationError(file, error)) {
        throw error;
      }

      const code = String(error?.code || "UNKNOWN");
      const message = String(error?.message || "Unknown migration error");
      console.warn(`     skip (legacy-incompatible, code=${code}): ${message}`);
      skippedFiles.push(path.basename(file));
      await client.query("ROLLBACK");
    }
  }
  return skippedFiles;
}

function escapeIdentifier(identifier) {
  return String(identifier).replace(/"/g, "\"\"");
}

export function filterResettableTables(rows) {
  return rows
    .map((row) => ({
      schema: String(row?.table_schema || "").trim(),
      table: String(row?.table_name || "").trim(),
    }))
    .filter((row) => row.schema === "public" && row.table)
    .sort((a, b) => {
      if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
      return a.table.localeCompare(b.table);
    });
}

async function truncateResettableTables(client) {
  const existingResult = await client.query(
    `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema = 'public'
    `,
  );

  const targets = filterResettableTables(existingResult.rows);
  if (!targets.length) {
    console.log("Data reset: no public schema tables found to truncate.");
    return;
  }

  const qualifiedTables = targets
    .map(({ schema, table }) => `"${escapeIdentifier(schema)}"."${escapeIdentifier(table)}"`)
    .join(", ");

  await client.query(`TRUNCATE TABLE ${qualifiedTables} RESTART IDENTITY CASCADE`);
  console.log(`Data reset: truncated ${targets.length} public schema tables (litellm schema untouched).`);
}

const BILLING_PLAN_INSERT_SQL_PATTERN = /INSERT\s+INTO\s+billing_plans\b[\s\S]*?;/gi;

export function extractBillingPlansSeedSql(sqlText) {
  const content = String(sqlText || "");
  const matches = content.match(BILLING_PLAN_INSERT_SQL_PATTERN) || [];
  if (!matches.length) return "";
  return String(matches[matches.length - 1] || "").trim();
}

function resolveBillingPlansSeedSqlFromMigrations(migrationFiles, fileReader = fs) {
  let seedSql = "";
  for (const file of migrationFiles) {
    const sql = fileReader.readFileSync(file, "utf8");
    const candidate = extractBillingPlansSeedSql(sql);
    if (candidate) {
      seedSql = candidate;
    }
  }
  return seedSql;
}

export async function seedBillingPlansFromMigrationsIfEmpty(client, migrationFiles, fileReader = fs) {
  const tableExistsResult = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'billing_plans'
      ) AS billing_plans_exists
    `,
  );

  if (!tableExistsResult.rows[0]?.billing_plans_exists) {
    console.log("Billing plans: table does not exist yet, skipping seed.");
    return false;
  }

  const countResult = await client.query("SELECT COUNT(*) AS plan_count FROM billing_plans");
  const planCount = Number.parseInt(String(countResult.rows[0]?.plan_count || "0"), 10) || 0;
  if (planCount > 0) {
    console.log(`Billing plans: already populated (${planCount} row(s)).`);
    return false;
  }

  const seedSql = resolveBillingPlansSeedSqlFromMigrations(migrationFiles, fileReader);
  if (!seedSql) {
    throw new Error("No billing_plans seed SQL found in migration files.");
  }

  await client.query(seedSql);

  const verifyResult = await client.query("SELECT COUNT(*) AS plan_count FROM billing_plans");
  const seededCount = Number.parseInt(String(verifyResult.rows[0]?.plan_count || "0"), 10) || 0;
  if (seededCount <= 0) {
    throw new Error("billing_plans seed SQL executed but billing_plans is still empty.");
  }

  console.log(`Billing plans: seeded from migration SQL (${seededCount} row(s)).`);
  return true;
}

async function main() {
  let dbUrl = "";
  let migrationsDir = "apis/db/migrations";
  let shouldTruncateData = true;
  let truncateOnly = false;
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--from-migrations") {
      continue;
    }
    if (arg === "--migrations-dir") {
      i += 1;
      if (i >= args.length) fail("--migrations-dir requires a value");
      migrationsDir = args[i];
      continue;
    }
    if (arg === "--db-url") {
      i += 1;
      if (i >= args.length) fail("--db-url requires a value");
      dbUrl = args[i];
      continue;
    }
    if (arg === "--truncate-data") {
      shouldTruncateData = true;
      continue;
    }
    if (arg === "--keep-data") {
      shouldTruncateData = false;
      continue;
    }
    if (arg === "--truncate-only") {
      shouldTruncateData = true;
      truncateOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!dbUrl) {
    dbUrl = readEnvValue(path.join(ROOT_DIR, "apis/.env"), "SUPABASE_DB_URL");
  }
  if (!dbUrl) {
    dbUrl = process.env.SUPABASE_DB_URL || "";
  }
  if (!dbUrl) {
    fail(
      `Missing SUPABASE_DB_URL in ${path.join(ROOT_DIR, "apis/.env")} (or set SUPABASE_DB_URL / pass --db-url).`,
    );
  }

  const resolvedMigrationsDir = resolveDir(migrationsDir);
  if (!resolvedMigrationsDir) {
    fail(`Migrations directory not found: ${migrationsDir}`);
  }

  const ensureFiles = resolveEnsureFiles(resolvedMigrationsDir);

  let pgModule;
  try {
    pgModule = await import("pg");
  } catch {
    fail("Missing dependency 'pg'. Run npm install first.");
  }

  const client = new pgModule.default.Client({ connectionString: dbUrl });
  const projectRefFromUrl = extractSupabaseProjectRefFromUrl(dbUrl);

  try {
    await client.connect();

    const identityResult = await client.query(
      "SELECT current_database() AS db_name, current_setting('app.settings.project_ref', true) AS project_ref",
    );
    const serverDbName = String(identityResult.rows[0]?.db_name || "").trim();
    const serverProjectRef = String(identityResult.rows[0]?.project_ref || "").trim();
    const projectRef = serverProjectRef || projectRefFromUrl;

    if (!serverDbName) {
      fail("Unable to read database name from server.");
    }

    if (shouldTruncateData) {
      console.log("Running Pinclaw DB data reset (truncate public schema tables; litellm schema excluded)...");
    }
    console.log("Checking Pinclaw DB schema...");
    console.log(`Target database (from server): ${serverDbName}`);
    if (projectRef) {
      console.log(`Target Supabase project ref: ${projectRef}`);
    }

    if (shouldTruncateData) {
      await truncateResettableTables(client);
      if (truncateOnly) {
        console.log("Done. Pinclaw data reset completed.");
        return;
      }
    }

    const beforeSnapshot = await loadSchemaSnapshot(client);
    const beforeGaps = collectSchemaGaps(beforeSnapshot);

    if (!beforeGaps.missingTables.length && !beforeGaps.missingColumns.length) {
      console.log(
        "Pre-check: required Pinclaw tables/columns already exist. Running all migrations anyway to avoid missing newly added objects.",
      );
    } else {
      printGaps(beforeGaps, "Schema gaps detected before migration apply:");
    }
    console.log("Applying all migration SQL files in order...");
    const skippedFiles = await applySqlFiles(client, ensureFiles);

    const afterSnapshot = await loadSchemaSnapshot(client);
    const afterGaps = collectSchemaGaps(afterSnapshot);

    if (afterGaps.missingTables.length || afterGaps.missingColumns.length) {
      printGaps(afterGaps, "Schema gaps still remain after ensure:");
      fail("Schema ensure incomplete. Please check migrations and DB state.");
    }

    await seedBillingPlansFromMigrationsIfEmpty(client, ensureFiles);

    if (skippedFiles.length) {
      console.log("Completed with legacy-compatible skips:");
      for (const skipped of skippedFiles) {
        console.log(`  - ${skipped}`);
      }
    }

    console.log("Done. Pinclaw schema check/ensure completed.");
  } finally {
    await client.end().catch(() => {});
  }
}

function isEntrypoint() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return import.meta.url === pathToFileURL(path.resolve(argvPath)).href;
}

if (isEntrypoint()) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
