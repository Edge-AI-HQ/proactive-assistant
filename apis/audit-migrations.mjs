#!/usr/bin/env node
import pg from "pg";

const url = process.argv[2];
const label = process.argv[3] ?? "db";
if (!url) {
  console.error("usage: node audit-migrations.mjs <postgres-url> <label>");
  process.exit(1);
}

const c = new pg.Client({ connectionString: url });
await c.connect();

const out = (k, v) => console.log(JSON.stringify({ env: label, [k]: v }));

const q = async (sql, params = []) => (await c.query(sql, params)).rows;

// 0. schema_migrations state
try {
  const applied = await q("SELECT number, name, applied_at FROM schema_migrations ORDER BY number");
  out("applied_migrations", applied);
} catch (e) {
  out("applied_migrations_error", e.message);
}

// Helper: check column existence + nullability
const colMeta = async (table, column) =>
  q(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );

// Helper: check table existence + rowcount (cheap if missing)
const tableInfo = async (table) => {
  const exists = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  if (exists.length === 0) return { exists: false };
  const { rows } = await c.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
  return { exists: true, rows: Number(rows[0].n) };
};

// ===== Migration 004 =====
const m4 = {};

// FK columns to be dropped
for (const [t, col] of [
  ["runtime_instances", "assistant_id"],
  ["payment_sessions", "assistant_id"],
  ["payment_sessions", "telegram_username_snapshot"],
  ["subscription_periods", "assistant_id"],
  ["payment_events", "assistant_id"],
]) {
  const meta = await colMeta(t, col);
  let nonNull = null;
  if (meta.length > 0) {
    try {
      const r = await c.query(
        `SELECT COUNT(*)::bigint AS n FROM "${t}" WHERE "${col}" IS NOT NULL`
      );
      nonNull = Number(r.rows[0].n);
    } catch (e) {
      nonNull = `err: ${e.message}`;
    }
  }
  m4[`${t}.${col}`] = { exists: meta.length > 0, non_null_rows: nonNull };
}

// runtime_instances.scope distribution (new constraint forbids 'assistant')
try {
  const dist = await q(`SELECT scope, COUNT(*)::bigint AS n FROM runtime_instances GROUP BY scope`);
  m4["runtime_instances.scope_distribution"] = dist.map((r) => ({ scope: r.scope, n: Number(r.n) }));
} catch (e) {
  m4["runtime_instances.scope_distribution_error"] = e.message;
}

// Tables to be dropped
for (const t of [
  "vnc_access_tokens",
  "google_oauth_credentials",
  "google_oauth_states",
  "gateway_sessions",
  "user_pending_actions",
  "assistants",
]) {
  m4[`table:${t}`] = await tableInfo(t);
}

// FKs referencing tables we drop (outside the migration's own scope)
const fkRefs = await q(
  `
  SELECT con.conname AS constraint_name,
         child.relname AS child_table,
         a.attname AS child_column,
         parent.relname AS parent_table
    FROM pg_constraint con
    JOIN pg_class child  ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_attribute a  ON a.attrelid = child.oid AND a.attnum = ANY(con.conkey)
   WHERE con.contype='f'
     AND parent.relname IN ('assistants','gateway_sessions','google_oauth_credentials','google_oauth_states','vnc_access_tokens','user_pending_actions')
   ORDER BY parent_table, child_table
  `
);
m4.foreign_keys_pointing_to_dropped_tables = fkRefs;

// Views / functions referencing the dropped tables or telegram columns (that CASCADE would silently drop)
const dependents = await q(
  `
  SELECT DISTINCT
         dep_class.relkind AS kind,
         dep_ns.nspname || '.' || dep_class.relname AS dependent
    FROM pg_depend d
    JOIN pg_class src_class ON src_class.oid = d.refobjid
    JOIN pg_namespace src_ns ON src_ns.oid = src_class.relnamespace
    JOIN pg_class dep_class ON dep_class.oid = d.objid
    JOIN pg_namespace dep_ns ON dep_ns.oid = dep_class.relnamespace
   WHERE src_ns.nspname = 'public'
     AND src_class.relname IN ('users','assistants','gateway_sessions','google_oauth_credentials','google_oauth_states','vnc_access_tokens','user_pending_actions','runtime_instances','payment_sessions','subscription_periods','payment_events')
     AND dep_class.relkind IN ('v','m','f') -- views, matviews, foreign tables
     AND dep_ns.nspname NOT IN ('pg_catalog','information_schema')
   ORDER BY dependent
  `
);
m4.view_or_matview_dependents = dependents;

// Functions referencing dropped objects by name
const funcs = await q(
  `
  SELECT n.nspname || '.' || p.proname AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'cleanup_expired_vnc_tokens'
  `
);
m4.cleanup_function_present = funcs.length > 0;

// users.telegram_* rowcounts (data loss)
for (const col of ["telegram_user_id", "telegram_username"]) {
  const meta = await colMeta("users", col);
  if (meta.length === 0) {
    m4[`users.${col}`] = { exists: false };
    continue;
  }
  const r = await c.query(`SELECT COUNT(*)::bigint AS n FROM users WHERE ${col} IS NOT NULL`);
  m4[`users.${col}`] = { exists: true, non_null_rows: Number(r.rows[0].n) };
}

// users_telegram_user_id_check constraint
const tg_check = await q(
  `SELECT conname FROM pg_constraint WHERE conname='users_telegram_user_id_check'`
);
m4.users_telegram_user_id_check_present = tg_check.length > 0;

out("migration_004", m4);

// ===== Migration 005 =====
const m5 = {};
const gtMeta = await colMeta("users", "gateway_token");
m5["users.gateway_token"] = gtMeta[0] ?? null;

const cpsMeta = await colMeta("users", "container_proxy_secret");
m5["users.container_proxy_secret"] = cpsMeta[0] ?? null;

if (gtMeta.length > 0) {
  const stats = await q(`
    SELECT
      COUNT(*)::bigint                                   AS total,
      COUNT(*) FILTER (WHERE gateway_token IS NULL)::bigint AS null_count,
      COUNT(DISTINCT gateway_token)::bigint              AS distinct_count
    FROM users
  `);
  m5["users_gateway_token_stats"] = {
    total: Number(stats[0].total),
    null_count: Number(stats[0].null_count),
    distinct_count: Number(stats[0].distinct_count),
  };
}
const gtConstraint = await q(`SELECT conname FROM pg_constraint WHERE conname='users_gateway_token_key'`);
m5.users_gateway_token_key_present = gtConstraint.length > 0;
const cpsConstraint = await q(`SELECT conname FROM pg_constraint WHERE conname='users_container_proxy_secret_unique'`);
m5.users_container_proxy_secret_unique_present = cpsConstraint.length > 0;

out("migration_005", m5);

// ===== Migration 006 =====
const m6 = {};
m6["users.gateway_token (will drop)"] = (await colMeta("users", "gateway_token"))[0] ?? null;
m6["users.litellm_rpm_limit"] = (await colMeta("users", "litellm_rpm_limit"))[0] ?? null;
m6["users.litellm_tpm_limit"] = (await colMeta("users", "litellm_tpm_limit"))[0] ?? null;
m6.users_gateway_token_key_constraint = await q(
  `SELECT conname FROM pg_constraint WHERE conname='users_gateway_token_key'`
);
out("migration_006", m6);

await c.end();
