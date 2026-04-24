/**
 * Local SQLite data access layer for the proactive-ai plugin.
 *
 * Replaces Supabase with better-sqlite3.  One container = one user,
 * so there is no user_id scoping — all data belongs to the single user.
 * Interfaces keep a `user_id` field populated with 'local' so callers
 * that read it don't break.
 *
 * DB file: ${OPENCLAW_HOME}/data/proactive.db  (on Fly volume)
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { makeIntentKey, makeTitleKey } from './shared/intent-key.js';

// ── Singleton DB ──

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const home = process.env.OPENCLAW_HOME || '/app';
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'proactive.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  ensureSchema(_db);
  return _db;
}

export function resetDbForTests(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function genId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

const USER_ID = 'local';

// ── Schema ──

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en-US',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      summary TEXT,
      facts TEXT NOT NULL DEFAULT '{}',
      preferences TEXT NOT NULL DEFAULT '{}',
      constraints TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- profile_memories was the v2 sink; rows are migrated into the v3
    -- memory table by migrateLegacyToV3 (called at end of ensureSchema)
    -- and the legacy table is dropped. addMemory/listMemories/searchMemory/
    -- removeMemory now adapt to the v3 memory table while preserving the
    -- old MemoryRow shape so existing callers don't break.
    -- See docs/plans/memory-architecture.mdx §七 (migration map).

    -- ─────── v3 memory: sedimented user-fact layer ───────
    -- See docs/plans/memory-architecture.mdx §三 (memory).
    -- Single quality-graded table, replaces (in v3) profile_memories +
    -- profile_interests + goals + a portion of profile JSON fields.
    -- profile_memories above is kept for backward-compat during migration;
    -- new writes go to the v3 memory table below.
    CREATE TABLE IF NOT EXISTS memory (
      id                 TEXT PRIMARY KEY,
      text               TEXT NOT NULL,
      source             TEXT NOT NULL,
      source_run_id      TEXT,
      subject            TEXT,
      quality            REAL NOT NULL DEFAULT 0.5,
      confidence         REAL NOT NULL DEFAULT 0.5,
      status             TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'archived', 'superseded')),
      superseded_by      TEXT,
      occurred_at        TEXT,
      created_at         TEXT NOT NULL,
      tags_json          TEXT NOT NULL DEFAULT '[]',
      related_memory_ids TEXT NOT NULL DEFAULT '[]',
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_status_quality
      ON memory(status, quality DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_subject_created
      ON memory(subject, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_source_run
      ON memory(source_run_id);

    -- ─────── v3 skill_index: skill metadata; body lives in folder ───────
    -- See docs/plans/memory-architecture.mdx §三 (skill_index).
    -- Body markdown is at  OPENCLAW_HOME/data/skills/<id>/SKILL.md
    -- user_skills (above) is the v2 sink — kept for backward-compat.
    CREATE TABLE IF NOT EXISTS skill_index (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      description         TEXT,
      status              TEXT NOT NULL DEFAULT 'enabled'
                          CHECK (status IN ('enabled', 'disabled', 'archived')),
      revision            INTEGER NOT NULL DEFAULT 1,
      body_hash           TEXT NOT NULL,
      triggers_json       TEXT NOT NULL DEFAULT '[]',
      source              TEXT NOT NULL,
      created_run_id      TEXT,
      last_updated_run_id TEXT,
      enabled_at          TEXT,
      disabled_at         TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      reference_count     INTEGER NOT NULL DEFAULT 0,
      last_referenced_at  TEXT,
      referenced_by_runs  TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_skill_index_status
      ON skill_index(status, updated_at DESC);

    -- ─────── v3 personal_signals:待消化的瞬时观察 ───────
    -- See docs/plans/memory-architecture.mdx §三 (personal_signals).
    -- Schema is compatible with the device-side MobileSyncItem contract
    -- (kind/title/summary/payload/salience/confidence/dedupeKey/occurredAt/...).
    -- Legacy mobile_items.db is no longer a read path; device uploads write
    -- directly here, with snapshot payloads fanned out to raw.db.
    CREATE TABLE IF NOT EXISTS personal_signals (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL,
      title               TEXT NOT NULL,
      summary             TEXT NOT NULL,
      payload_json        TEXT NOT NULL DEFAULT '{}',
      salience            REAL NOT NULL DEFAULT 0,
      confidence          REAL NOT NULL DEFAULT 0,
      dedupe_key          TEXT,
      occurred_at         TEXT NOT NULL,
      available_at        TEXT NOT NULL,
      expires_at          TEXT,
      source              TEXT NOT NULL DEFAULT 'device',
      device_id           TEXT,
      subject             TEXT,
      source_raw_table    TEXT,
      source_raw_ids_json TEXT NOT NULL DEFAULT '[]',
      status              TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'consumed', 'archived')),
      consumed_by_run_id  TEXT,
      ingested_at         TEXT NOT NULL,
      reference_count     INTEGER NOT NULL DEFAULT 0,
      last_referenced_at  TEXT,
      referenced_by_runs  TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_psignals_dedupe
      ON personal_signals(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_psignals_status_time
      ON personal_signals(status, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_psignals_kind_time
      ON personal_signals(kind, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS profile_signals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      value REAL,
      source TEXT,
      context TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_occurred ON profile_signals(occurred_at DESC);

    CREATE TABLE IF NOT EXISTS profile_interests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_signal_at TEXT,
      UNIQUE(kind, key)
    );

    CREATE TABLE IF NOT EXISTS feedback_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      action TEXT,
      push_id TEXT,
      intent_card_id TEXT,
      intent_key TEXT,
      source TEXT NOT NULL DEFAULT 'user_direct',
      basket TEXT,
      value TEXT,
      text TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_events(created_at DESC);

    -- push_records / push_outcomes were carried over from a v2 push-feature
    -- experiment that was never shipped. Dropped in the Phase 15 cleanup
    -- pass — see docs/memory-architecture.md §八.
    DROP TABLE IF EXISTS push_outcomes;
    DROP TABLE IF EXISTS push_records;

    -- v3 world_signals (formerly world_items). External news / context
    -- stream — the public-data analogue of personal_signals.
    -- See docs/plans/memory-architecture.mdx §三 (world_signals).
    CREATE TABLE IF NOT EXISTS world_signals (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      stream_type TEXT NOT NULL DEFAULT 'search',
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL UNIQUE,
      external_id TEXT,
      summary TEXT,
      published_at TEXT,
      search_queries TEXT NOT NULL DEFAULT '[]',
      topics TEXT NOT NULL DEFAULT '[]',
      regions TEXT NOT NULL DEFAULT '[]',
      importance TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_world_signals_published
      ON world_signals(published_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      total_iterations INTEGER,
      final_cards TEXT,
      iterations TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_started ON pipeline_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS user_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generation_language TEXT NOT NULL DEFAULT 'zh-Hans',
      auto_generate INTEGER NOT NULL DEFAULT 0,
      auto_dreaming INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    -- auto_loop_state was a single-row table with the latest auto-loop tick
    -- summary; collapsed into app_state['scheduler.autoLoopState'] in
    -- Phase 15. Dropped via migrateAutoLoopStateToAppState below.

    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('auto', 'manual')),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      source_stats TEXT,
      summary TEXT,
      profile_delta TEXT,
      goal_delta TEXT,
      journal_markdown TEXT,
      candidates TEXT,
      applied_at TEXT,
      goals_applied_at TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dream_started ON dream_runs(started_at DESC);

    -- ─────── v3 evolution_runs: unified ledger for dream / crystallize / manual ───────
    -- See docs/plans/memory-architecture.mdx §三 (evolution_runs).
    -- Replaces (in v3) the per-domain run tables (dream_runs above stays for
    -- back-compat). chat_burst = formerly conversation-crystallize trigger;
    -- daily_dream = formerly dreaming/service.ts trigger; manual = CLI;
    -- consolidation = future memory-pruning pass.
    CREATE TABLE IF NOT EXISTS evolution_runs (
      id                       TEXT PRIMARY KEY,
      trigger_kind             TEXT NOT NULL CHECK (trigger_kind IN
                                ('chat_burst', 'daily_dream', 'manual', 'on_event', 'consolidation')),
      status                   TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      context_summary          TEXT,
      window_start             TEXT,
      window_end               TEXT,
      memories_written         INTEGER NOT NULL DEFAULT 0,
      memories_archived        INTEGER NOT NULL DEFAULT 0,
      memories_superseded      INTEGER NOT NULL DEFAULT 0,
      profile_updated          INTEGER NOT NULL DEFAULT 0,
      profile_changed_keys_json TEXT NOT NULL DEFAULT '[]',
      skills_added             INTEGER NOT NULL DEFAULT 0,
      skills_updated           INTEGER NOT NULL DEFAULT 0,
      skills_disabled          INTEGER NOT NULL DEFAULT 0,
      signals_consumed         INTEGER NOT NULL DEFAULT 0,
      refs_consumed_json       TEXT NOT NULL DEFAULT '{}',
      refs_produced_json       TEXT NOT NULL DEFAULT '{}',
      prompt_excerpt           TEXT,
      llm_tokens               INTEGER,
      duration_ms              INTEGER,
      started_at               TEXT NOT NULL,
      completed_at             TEXT,
      error_message            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evol_runs_started ON evolution_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evol_runs_trigger_started
      ON evolution_runs(trigger_kind, started_at DESC);

    CREATE TABLE IF NOT EXISTS app_state (
      namespace  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL DEFAULT 'null',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );

    CREATE TABLE IF NOT EXISTS card_evaluations (
      card_id              TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      intent_key           TEXT,
      basket               TEXT,
      dim_relevance        REAL,
      dim_actionability    REAL,
      dim_why_now          REAL,
      dim_novelty          REAL,
      dim_decision_compress REAL,
      overall              REAL,
      pass                 INTEGER NOT NULL DEFAULT 1,
      evaluator            TEXT NOT NULL DEFAULT 'self',
      feedback_text        TEXT,
      evaluated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_card_eval_run ON card_evaluations(run_id);
    CREATE INDEX IF NOT EXISTS idx_card_eval_basket_score
      ON card_evaluations(basket, overall DESC);

    CREATE TABLE IF NOT EXISTS intent_card_state (
      card_id TEXT PRIMARY KEY,
      intent_key TEXT NOT NULL,
      goal_basket TEXT NOT NULL,
      latest_outcome TEXT NOT NULL DEFAULT 'none',
      outcome_at TEXT,
      has_deep_chat INTEGER NOT NULL DEFAULT 0,
      latest_chat_decision TEXT NOT NULL DEFAULT 'none',
      latest_chat_summary TEXT,
      next_angles_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intent_thread_state (
      intent_key TEXT PRIMARY KEY,
      goal_basket TEXT NOT NULL,
      latest_card_id TEXT,
      latest_generated_at TEXT,
      latest_card_outcome TEXT NOT NULL DEFAULT 'none',
      has_any_confirmed_card INTEGER NOT NULL DEFAULT 0,
      has_any_dismissed_card INTEGER NOT NULL DEFAULT 0,
      latest_chat_decision TEXT NOT NULL DEFAULT 'none',
      latest_chat_summary TEXT,
      next_angles_json TEXT NOT NULL DEFAULT '[]',
      thread_decision TEXT NOT NULL DEFAULT 'hold',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_intent_thread_state_updated ON intent_thread_state(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_intent_thread_state_goal_basket ON intent_thread_state(goal_basket);

    -- chat_crystallize_state was a single-row table tracking the crystallize
    -- counter / cooldown. Collapsed into app_state['crystallize.state'] in
    -- Phase 15. Dropped via migrateCrystallizeStateToAppState below.

    -- user_skills was the v2 sink; rows are migrated into skill_index +
    -- skills/<id>/SKILL.md by migrateLegacyToV3 and the legacy table is
    -- dropped. addUserSkill/listUserSkills/getUserSkill now adapt to the
    -- v3 skill_index while preserving the old UserSkillRow shape.
  `);

  ensureColumn(db, 'feedback_events', 'conversation_id', 'TEXT');
  ensureColumn(db, 'feedback_events', 'message_id', 'TEXT');
  ensureColumn(db, 'feedback_events', 'channel', 'TEXT');
  ensureColumn(db, 'feedback_events', 'intent_key', 'TEXT');
  ensureColumn(db, 'user_settings', 'auto_crystallize', 'INTEGER NOT NULL DEFAULT 1');

  // Phase 1: pipeline_runs.artifact_path stores filesystem path to large iterations JSON
  ensureColumn(db, 'pipeline_runs', 'artifact_path', 'TEXT');

  // Phase 1: drop deprecated tables (zero-row, no callers; replaced by app_state KV)
  // See docs/plans/memory-architecture.mdx for migration map.
  db.exec(`
    DROP TABLE IF EXISTS pending_items;
    DROP TABLE IF EXISTS context_runs;
    DROP TABLE IF EXISTS ingest_cursor;
  `);

  // Phase 6: rename world_items → world_signals (preserves rows + adds the
  // reference triple). See docs/plans/memory-architecture.mdx §三 (world_signals).
  migrateWorldItemsToSignals(db);

  // Phase 13: one-shot backfill of legacy tables into v3 sinks, then DROP
  // the legacy tables. Idempotent — safe to run on every container start.
  // We're pre-product, no users to protect; the goal is "data preserved,
  // schema clean".  See docs/plans/memory-architecture.mdx §七 (migration map).
  migrateLegacyToV3(db);

  // Phase 15: collapse the two single-row "state" tables into the
  // app_state KV (which already exists for this exact use). Idempotent.
  // See docs/memory-architecture.md §八 Phase 15.
  migrateAutoLoopStateToAppState(db);
  migrateCrystallizeStateToAppState(db);
}

/**
 * Phase 13: one-shot backfill of legacy v2 tables into v3 sinks, then
 * DROP the legacy tables. Idempotent (no-op once tables are gone).
 *
 * Pre-product cutover: we move the data we still want, drop the rest.
 * No multi-week dual-write window. See docs/plans/memory-architecture.mdx §七.
 */
function migrateLegacyToV3(db: Database.Database): void {
  // ── profile_memories → memory ──
  const pmExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='profile_memories'",
  ).get();
  if (pmExists) {
    const rows = db.prepare(
      `SELECT pm.id, pm.kind, pm.text, pm.tags, pm.created_at
       FROM profile_memories pm
       LEFT JOIN memory m ON m.id = pm.id
       WHERE m.id IS NULL`,
    ).all() as Array<{ id: string; kind: string; text: string; tags: string; created_at: string }>;
    if (rows.length > 0) {
      const insert = db.prepare(
        `INSERT INTO memory (
           id, text, source, source_run_id, subject, quality, confidence,
           status, superseded_by, occurred_at, created_at,
           tags_json, related_memory_ids,
           reference_count, last_referenced_at, referenced_by_runs
         ) VALUES (?, ?, ?, NULL, 'self', 0.5, 0.5, 'active', NULL, NULL, ?, ?, '[]', 0, NULL, '[]')`,
      );
      const tx = db.transaction(() => {
        for (const r of rows) {
          insert.run(r.id, r.text, `legacy:${r.kind || 'profile_memory'}`, r.created_at, r.tags || '[]');
        }
      });
      tx();
    }
    db.exec('DROP TABLE profile_memories');
  }

  // ── user_skills → skill_index + skills/<id>/SKILL.md ──
  const usExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='user_skills'",
  ).get();
  if (usExists) {
    const rows = db.prepare(
      `SELECT us.id, us.title, us.body_md, us.triggers_json, us.source, us.status,
              us.source_summary, us.created_at, us.updated_at
       FROM user_skills us
       LEFT JOIN skill_index si ON si.id = us.id
       WHERE si.id IS NULL`,
    ).all() as Array<{
      id: string; title: string; body_md: string; triggers_json: string;
      source: string; status: string; source_summary: string | null;
      created_at: string; updated_at: string;
    }>;
    if (rows.length > 0) {
      const skillsDir = path.join(process.env.OPENCLAW_HOME || '/app', 'data', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      const insert = db.prepare(
        `INSERT INTO skill_index (
           id, title, description, status, revision, body_hash, triggers_json,
           source, created_run_id, last_updated_run_id,
           enabled_at, disabled_at, created_at, updated_at,
           reference_count, last_referenced_at, referenced_by_runs
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, NULL, '[]')`,
      );
      const tx = db.transaction(() => {
        for (const r of rows) {
          // Write the body to skills/<id>/SKILL.md
          const folder = path.join(skillsDir, r.id);
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'SKILL.md'), r.body_md);
          const bodyHash = crypto.createHash('sha256').update(r.body_md).digest('hex');
          const newStatus = r.status === 'active' ? 'enabled' : 'disabled';
          insert.run(
            r.id, r.title, r.source_summary, newStatus,
            bodyHash, r.triggers_json || '[]', r.source,
            newStatus === 'enabled' ? r.created_at : null,
            newStatus === 'disabled' ? r.updated_at : null,
            r.created_at, r.updated_at,
          );
        }
      });
      tx();
    }
    db.exec('DROP TABLE user_skills');
  }

  // dream_runs is intentionally NOT migrated/dropped here — the dreaming/
  // subsystem owns it as a private internal store. New dream attempts also
  // write a summary mirror to evolution_runs (see Phase 8 hook in
  // dreaming/service.ts). Eventually the whole subsystem can be retargeted,
  // but that's out of scope for the cutover.
}

/**
 * Idempotent migration: if the legacy `world_items` table still exists,
 * add the v3 reference columns to it and rename to `world_signals`.
 * No-op once the rename has been applied. Safe to call on every startup.
 */
function migrateWorldItemsToSignals(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='world_items'",
  ).get();
  if (!exists) return;

  // The new world_signals table may already exist from the IF NOT EXISTS
  // CREATE above (fresh installs). If so, copy rows in and drop the legacy.
  ensureColumn(db, 'world_items', 'reference_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'world_items', 'last_referenced_at', 'TEXT');
  ensureColumn(db, 'world_items', 'referenced_by_runs', "TEXT NOT NULL DEFAULT '[]'");

  const newTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='world_signals'",
  ).get();
  if (newTableExists) {
    db.exec(`
      INSERT OR IGNORE INTO world_signals
        (id, provider, stream_type, title, url, normalized_url, external_id,
         summary, published_at, search_queries, topics, regions, importance,
         metadata, created_at, updated_at,
         reference_count, last_referenced_at, referenced_by_runs)
      SELECT
        id, provider, stream_type, title, url, normalized_url, external_id,
        summary, published_at, search_queries, topics, regions, importance,
        metadata, created_at, updated_at,
        reference_count, last_referenced_at, referenced_by_runs
      FROM world_items;
      DROP TABLE world_items;
    `);
    return;
  }

  // No new table yet (race-free old install) — just rename.
  db.exec('ALTER TABLE world_items RENAME TO world_signals');
}

/**
 * Phase 15: backfill auto_loop_state's single row into app_state then DROP
 * the table. The KV layout intentionally matches the AutoLoopStateRow
 * shape minus `user_id` (single-tenant container, no need to store it).
 * Idempotent — no-op once the table is gone.
 */
function migrateAutoLoopStateToAppState(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='auto_loop_state'",
  ).get();
  if (!exists) return;

  const row = db.prepare(
    'SELECT last_started_at, last_finished_at, last_status, updated_at FROM auto_loop_state WHERE id = 1',
  ).get() as { last_started_at: string | null; last_finished_at: string | null; last_status: string | null; updated_at: string } | undefined;

  if (row) {
    const value = JSON.stringify({
      last_started_at: row.last_started_at,
      last_finished_at: row.last_finished_at,
      last_status: row.last_status,
      updated_at: row.updated_at,
    });
    db.prepare(
      `INSERT INTO app_state (namespace, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run('scheduler', 'autoLoopState', value, row.updated_at);
  }

  db.exec('DROP TABLE auto_loop_state');
}

/**
 * Phase 15: backfill chat_crystallize_state's single row into app_state
 * then DROP the table. Same shape as ChatCrystallizeStateRow minus the
 * synthetic `id`. Idempotent — no-op once the table is gone.
 */
function migrateCrystallizeStateToAppState(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_crystallize_state'",
  ).get();
  if (!exists) return;

  const row = db.prepare(
    `SELECT turn_count, last_crystallized_at, last_session_key, last_message_at, updated_at
       FROM chat_crystallize_state WHERE id = 'default'`,
  ).get() as {
    turn_count: number; last_crystallized_at: string | null;
    last_session_key: string | null; last_message_at: string | null;
    updated_at: string;
  } | undefined;

  if (row) {
    const value = JSON.stringify({
      turn_count: row.turn_count,
      last_crystallized_at: row.last_crystallized_at,
      last_session_key: row.last_session_key,
      last_message_at: row.last_message_at,
      updated_at: row.updated_at,
    });
    db.prepare(
      `INSERT INTO app_state (namespace, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run('crystallize', 'state', value, row.updated_at);
  }

  db.exec('DROP TABLE chat_crystallize_state');
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  const exists = rows.some((row) => row.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Helpers ──

function parseJson<T = Record<string, unknown>>(raw: string | null | undefined): T {
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; } catch { return {} as T; }
}

function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export type CardOutcome = 'confirm' | 'modify' | 'dismiss' | 'snooze' | 'none';
export type ChatDecision = 'advance' | 'refine' | 'hold' | 'suppress' | 'none';
export type ThreadDecision = 'advance' | 'refine' | 'hold' | 'suppress';

export interface ThreadContext {
  intentKey: string;
  latestCardOutcome: CardOutcome;
  hasAnyConfirmedCard: boolean;
  hasAnyDismissedCard: boolean;
  latestChatDecision: ChatDecision;
  latestChatSummary: string | null;
  nextAngles: string[];
  threadDecision: ThreadDecision;
}

interface IntentCardStateRow {
  card_id: string;
  intent_key: string;
  goal_basket: string;
  latest_outcome: CardOutcome;
  outcome_at: string | null;
  has_deep_chat: number;
  latest_chat_decision: ChatDecision;
  latest_chat_summary: string | null;
  next_angles_json: string;
  updated_at: string;
}

interface IntentThreadStateRow {
  intent_key: string;
  goal_basket: string;
  latest_card_id: string | null;
  latest_generated_at: string | null;
  latest_card_outcome: CardOutcome;
  has_any_confirmed_card: number;
  has_any_dismissed_card: number;
  latest_chat_decision: ChatDecision;
  latest_chat_summary: string | null;
  next_angles_json: string;
  thread_decision: ThreadDecision;
  updated_at: string;
}

function deriveThreadDecision(outcome: CardOutcome, chatDecision: ChatDecision): ThreadDecision {
  if (chatDecision !== 'none') return chatDecision;
  switch (outcome) {
    case 'confirm':
      return 'advance';
    case 'modify':
      return 'refine';
    case 'dismiss':
      return 'suppress';
    case 'snooze':
    case 'none':
    default:
      return 'hold';
  }
}

function defaultThreadContext(intentKey: string): ThreadContext {
  return {
    intentKey,
    latestCardOutcome: 'none',
    hasAnyConfirmedCard: false,
    hasAnyDismissedCard: false,
    latestChatDecision: 'none',
    latestChatSummary: null,
    nextAngles: [],
    threadDecision: 'hold',
  };
}

// ── Profile ──

export interface ProfileRow {
  id: string;
  user_id: string;
  display_name: string;
  locale: string;
  timezone: string;
  summary: string | null;
  facts: Record<string, unknown>;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

function rowToProfile(row: any): ProfileRow {
  return {
    id: row.id,
    user_id: USER_ID,
    display_name: row.display_name,
    locale: row.locale,
    timezone: row.timezone,
    summary: row.summary ?? null,
    facts: parseJson(row.facts),
    preferences: parseJson(row.preferences),
    constraints: parseJson(row.constraints),
    metadata: parseJson(row.metadata),
  };
}

export async function getProfile(): Promise<ProfileRow | null> {
  const row = getDb().prepare('SELECT * FROM profile LIMIT 1').get() as any;
  return row ? rowToProfile(row) : null;
}

export async function deleteProfile(): Promise<void> {
  getDb().prepare('DELETE FROM profile').run();
}

export async function upsertProfile(input: {
  displayName: string;
  locale?: string;
  timezone?: string;
  summary?: string;
}): Promise<ProfileRow> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM profile LIMIT 1').get() as any;
  const id = existing?.id ?? genId();
  const ts = now();
  db.prepare(`
    INSERT INTO profile (id, display_name, locale, timezone, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      locale = excluded.locale,
      timezone = excluded.timezone,
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `).run(id, input.displayName, input.locale ?? 'en-US', input.timezone ?? 'UTC', input.summary ?? null, ts, ts);
  return (await getProfile())!;
}

export async function updateProfile(
  fields: Partial<Pick<ProfileRow, 'display_name' | 'locale' | 'timezone' | 'summary' | 'metadata'>>,
): Promise<ProfileRow> {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.display_name !== undefined) { sets.push('display_name = ?'); vals.push(fields.display_name); }
  if (fields.locale !== undefined) { sets.push('locale = ?'); vals.push(fields.locale); }
  if (fields.timezone !== undefined) { sets.push('timezone = ?'); vals.push(fields.timezone); }
  if (fields.summary !== undefined) { sets.push('summary = ?'); vals.push(fields.summary); }
  if (fields.metadata !== undefined) { sets.push('metadata = ?'); vals.push(JSON.stringify(fields.metadata)); }
  if (sets.length > 0) {
    sets.push('updated_at = ?'); vals.push(now());
    db.prepare(`UPDATE profile SET ${sets.join(', ')}`).run(...vals);
  }
  const result = await getProfile();
  if (!result) throw new Error('No profile to update');
  return result;
}

// ── Profile JSONB fields ──

async function getProfileJsonField(field: 'facts' | 'preferences' | 'constraints'): Promise<Record<string, unknown>> {
  const profile = await getProfile();
  return (profile?.[field] as Record<string, unknown>) ?? {};
}

async function setProfileJsonField(
  field: 'facts' | 'preferences' | 'constraints',
  key: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  const current = await getProfileJsonField(field);
  const updated = { ...current, [key]: value };
  getDb().prepare(`UPDATE profile SET ${field} = ?, updated_at = ?`).run(JSON.stringify(updated), now());
  return updated;
}

async function unsetProfileJsonField(
  field: 'facts' | 'preferences' | 'constraints',
  key: string,
): Promise<Record<string, unknown>> {
  const current = await getProfileJsonField(field);
  const { [key]: _, ...rest } = current;
  getDb().prepare(`UPDATE profile SET ${field} = ?, updated_at = ?`).run(JSON.stringify(rest), now());
  return rest;
}

export const getFacts = () => getProfileJsonField('facts');
export const setFact = (key: string, value: unknown) => setProfileJsonField('facts', key, value);
export const unsetFact = (key: string) => unsetProfileJsonField('facts', key);

export const getPreferences = () => getProfileJsonField('preferences');
export const setPreference = (key: string, value: unknown) => setProfileJsonField('preferences', key, value);
export const unsetPreference = (key: string) => unsetProfileJsonField('preferences', key);

export const getConstraints = () => getProfileJsonField('constraints');
export const setConstraint = (key: string, value: unknown) => setProfileJsonField('constraints', key, value);
export const unsetConstraint = (key: string) => unsetProfileJsonField('constraints', key);

// ── Goals ──

export interface GoalRow {
  id: string;
  user_id: string;
  key: string;
  title: string;
  priority: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

function rowToGoal(row: any): GoalRow {
  return { ...row, user_id: USER_ID };
}

export async function listGoals(): Promise<GoalRow[]> {
  const rows = getDb().prepare(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END"
  ).all() as any[];
  return rows.map(rowToGoal);
}

export async function upsertGoal(input: {
  key: string;
  title: string;
  priority?: string;
}): Promise<GoalRow> {
  const db = getDb();
  const id = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO goals (id, key, title, priority, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      title = excluded.title,
      priority = excluded.priority,
      status = 'active',
      updated_at = excluded.updated_at
  `).run(id, input.key, input.title, input.priority ?? 'medium', ts, ts);
  const row = db.prepare('SELECT * FROM goals WHERE key = ?').get(input.key) as any;
  return rowToGoal(row);
}

export async function closeGoal(key: string): Promise<GoalRow> {
  const ts = now();
  const db = getDb();
  db.prepare("UPDATE goals SET status = 'closed', closed_at = ?, updated_at = ? WHERE key = ?").run(ts, ts, key);
  const row = db.prepare('SELECT * FROM goals WHERE key = ?').get(key) as any;
  if (!row) throw new Error(`Goal not found: ${key}`);
  return rowToGoal(row);
}

// ── Profile Memories ──

// MemoryRow is the v2 envelope still consumed by cli/profile.ts and
// routes/profile.ts. After Phase 13 it's adapted from the v3 memory
// table — the legacy profile_memories table no longer exists.
// See docs/plans/memory-architecture.mdx §七.
export interface MemoryRow {
  id: string;
  user_id: string;
  /** v2 'kind' column. For v3-native rows we surface the source string here. */
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

/** Recover a v2-shaped 'kind' from the v3 source string. */
function v3SourceToLegacyKind(source: string): string {
  if (source.startsWith('legacy:')) return source.slice('legacy:'.length);
  return source;
}

function v3MemoryToLegacyRow(row: MemoryRowV3): MemoryRow {
  return {
    id: row.id,
    user_id: USER_ID,
    kind: v3SourceToLegacyKind(row.source),
    text: row.text,
    tags: row.tags,
    created_at: row.created_at,
  };
}

export async function listMemories(opts?: { limit?: number }): Promise<MemoryRow[]> {
  const v3 = await listMemoryV3({ status: 'active', limit: opts?.limit ?? 1000 });
  return v3.map(v3MemoryToLegacyRow);
}

export async function addMemory(input: {
  kind: string;
  text: string;
  tags?: string[];
}): Promise<MemoryRow> {
  const v3 = await addMemoryV3({
    text: input.text,
    source: `legacy:${input.kind || 'unknown'}`,
    subject: 'self',
    tags: input.tags ?? [],
  });
  return v3MemoryToLegacyRow(v3);
}

export async function searchMemory(query: string, opts?: { limit?: number }): Promise<MemoryRow[]> {
  const limit = opts?.limit ?? 20;
  // Substring search on text/subject/tags via the v3 table. listMemoryV3
  // doesn't support full-text yet (vector index is a future PR).
  const candidates = await listMemoryV3({ status: 'active', limit: 500, orderBy: 'created_at' });
  const lowered = query.toLowerCase();
  return candidates
    .filter((m) => m.text.toLowerCase().includes(lowered)
      || (m.subject ?? '').toLowerCase().includes(lowered)
      || m.tags.some((t) => t.toLowerCase().includes(lowered)))
    .slice(0, limit)
    .map(v3MemoryToLegacyRow);
}

export async function removeMemory(id: string): Promise<void> {
  getDb().prepare('DELETE FROM memory WHERE id = ?').run(id);
}

// ── Profile Signals ──

export interface SignalRow {
  id: string;
  user_id: string;
  kind: string;
  target_type: string;
  target_key: string;
  value: number | null;
  source: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}

function rowToSignal(row: any): SignalRow {
  return {
    ...row,
    user_id: USER_ID,
    context: row.context ? parseJson(row.context) : null,
  };
}

export async function listSignals(opts?: { since?: string; limit?: number }): Promise<SignalRow[]> {
  const parts = ['SELECT * FROM profile_signals'];
  const params: unknown[] = [];
  if (opts?.since) { parts.push('WHERE occurred_at >= ?'); params.push(opts.since); }
  parts.push('ORDER BY occurred_at DESC');
  parts.push('LIMIT ?'); params.push(opts?.limit ?? 1000);
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToSignal);
}

export async function addSignal(input: {
  kind: string;
  targetType: string;
  targetKey: string;
  value?: number;
  source?: string;
  context?: Record<string, unknown>;
}): Promise<SignalRow> {
  const id = genId();
  const ts = now();
  getDb().prepare(
    'INSERT INTO profile_signals (id, kind, target_type, target_key, value, source, context, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.kind, input.targetType, input.targetKey, input.value ?? null, input.source ?? null,
    input.context ? JSON.stringify(input.context) : null, ts, ts);
  return {
    id, user_id: USER_ID, kind: input.kind, target_type: input.targetType, target_key: input.targetKey,
    value: input.value ?? null, source: input.source ?? null, context: input.context ?? null,
    occurred_at: ts, created_at: ts,
  };
}

// ── Profile Interests ──

export interface InterestRow {
  id: string;
  user_id: string;
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidence_count: number;
  status: string;
  last_signal_at: string | null;
}

function rowToInterest(row: any): InterestRow {
  return { ...row, user_id: USER_ID };
}

export async function listInterests(opts?: { kind?: string; limit?: number }): Promise<InterestRow[]> {
  const parts = ["SELECT * FROM profile_interests WHERE status = 'active'"];
  const params: unknown[] = [];
  if (opts?.kind) { parts.push('AND kind = ?'); params.push(opts.kind); }
  parts.push('ORDER BY score DESC');
  if (opts?.limit) { parts.push('LIMIT ?'); params.push(opts.limit); }
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToInterest);
}

export async function upsertInterest(input: {
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidenceCount: number;
  lastSignalAt?: string;
}): Promise<InterestRow> {
  const db = getDb();
  const id = genId();
  const lastSignal = input.lastSignalAt ?? now();
  db.prepare(`
    INSERT INTO profile_interests (id, kind, key, score, confidence, evidence_count, status, last_signal_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(kind, key) DO UPDATE SET
      score = excluded.score,
      confidence = excluded.confidence,
      evidence_count = excluded.evidence_count,
      last_signal_at = excluded.last_signal_at
  `).run(id, input.kind, input.key, input.score, input.confidence, input.evidenceCount, lastSignal);
  const row = db.prepare('SELECT * FROM profile_interests WHERE kind = ? AND key = ?').get(input.kind, input.key) as any;
  return rowToInterest(row);
}

export async function rollupSignals(sinceDays = 30): Promise<InterestRow[]> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const signals = await listSignals({ since, limit: 1000 });

  const DECAY_HALF_LIFE_DAYS = 7;
  const nowMs = Date.now();
  const groups = new Map<string, { kind: string; key: string; total: number; count: number; lastAt: string }>();

  for (const sig of signals) {
    const gKey = `${sig.target_type}:${sig.target_key}`;
    const ageDays = (nowMs - new Date(sig.occurred_at).getTime()) / 86400_000;
    const weight = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS) * (sig.value ?? 1);
    const existing = groups.get(gKey);
    if (existing) {
      existing.total += weight;
      existing.count += 1;
      if (sig.occurred_at > existing.lastAt) existing.lastAt = sig.occurred_at;
    } else {
      groups.set(gKey, { kind: sig.target_type, key: sig.target_key, total: weight, count: 1, lastAt: sig.occurred_at });
    }
  }

  const maxScore = Math.max(...[...groups.values()].map(v => v.total), 1);
  const results: InterestRow[] = [];
  for (const g of groups.values()) {
    results.push(await upsertInterest({
      kind: g.kind,
      key: g.key,
      score: Math.round((g.total / maxScore) * 1000) / 1000,
      confidence: Math.round(Math.min(1, g.count / 10) * 1000) / 1000,
      evidenceCount: g.count,
      lastSignalAt: g.lastAt,
    }));
  }
  return results;
}

// ── Feedback ──

export interface FeedbackRow {
  id: string;
  user_id: string;
  kind: string;
  action: string | null;
  push_id: string | null;
  intent_card_id: string | null;
  intent_key: string | null;
  conversation_id: string | null;
  message_id: string | null;
  source: string;
  basket: string | null;
  channel: string | null;
  value: string | null;
  text: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function rowToFeedback(row: any): FeedbackRow {
  return { ...row, user_id: USER_ID, metadata: parseJson(row.metadata) };
}

export async function logFeedback(input: {
  kind: string;
  action?: string;
  pushId?: string;
  intentCardId?: string;
  intentKey?: string;
  conversationId?: string;
  messageId?: string;
  source?: string;
  basket?: string;
  channel?: string;
  value?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  at?: string;
}): Promise<FeedbackRow> {
  const id = genId();
  const ts = input.at ?? now();
  const intentKey = input.intentKey
    ?? (typeof input.metadata?.intentKey === 'string' ? input.metadata.intentKey : undefined)
    ?? null;
  const meta = JSON.stringify(input.metadata ?? {});
  getDb().prepare(
    'INSERT INTO feedback_events (id, kind, action, push_id, intent_card_id, intent_key, conversation_id, message_id, source, basket, channel, value, text, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.kind,
    input.action ?? null,
    input.pushId ?? null,
    input.intentCardId ?? null,
    intentKey,
    input.conversationId ?? null,
    input.messageId ?? null,
    input.source ?? 'user_direct',
    input.basket ?? null,
    input.channel ?? null,
    input.value ?? null,
    input.text ?? null,
    meta,
    ts,
  );
  return {
    id, user_id: USER_ID, kind: input.kind, action: input.action ?? null,
    push_id: input.pushId ?? null, intent_card_id: input.intentCardId ?? null,
    intent_key: intentKey,
    conversation_id: input.conversationId ?? null, message_id: input.messageId ?? null,
    source: input.source ?? 'user_direct', basket: input.basket ?? null,
    channel: input.channel ?? null,
    value: input.value ?? null, text: input.text ?? null,
    metadata: input.metadata ?? {}, created_at: ts,
  };
}

export async function listFeedback(opts?: {
  since?: string;
  kind?: string;
  action?: string;
  source?: string;
  basket?: string;
  channel?: string;
  pushId?: string;
  intentCardId?: string;
  intentKey?: string;
  limit?: number;
}): Promise<FeedbackRow[]> {
  const parts = ['SELECT * FROM feedback_events WHERE 1=1'];
  const params: unknown[] = [];
  if (opts?.since) { parts.push('AND created_at >= ?'); params.push(opts.since); }
  if (opts?.kind) { parts.push('AND kind = ?'); params.push(opts.kind); }
  if (opts?.action) { parts.push('AND action = ?'); params.push(opts.action); }
  if (opts?.source) { parts.push('AND source = ?'); params.push(opts.source); }
  if (opts?.basket) { parts.push('AND basket = ?'); params.push(opts.basket); }
  if (opts?.channel) { parts.push('AND channel = ?'); params.push(opts.channel); }
  if (opts?.pushId) { parts.push('AND push_id = ?'); params.push(opts.pushId); }
  if (opts?.intentCardId) { parts.push('AND intent_card_id = ?'); params.push(opts.intentCardId); }
  if (opts?.intentKey) { parts.push('AND intent_key = ?'); params.push(opts.intentKey); }
  parts.push('ORDER BY created_at DESC');
  if (opts?.limit) { parts.push('LIMIT ?'); params.push(opts.limit); }
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToFeedback);
}

export async function getFeedback(id: string): Promise<FeedbackRow | null> {
  const row = getDb().prepare('SELECT * FROM feedback_events WHERE id = ?').get(id) as any;
  return row ? rowToFeedback(row) : null;
}

export async function feedbackStats(opts?: {
  since?: string;
  basket?: string;
}): Promise<{ total: number; byKind: Record<string, number>; byAction: Record<string, number>; byBasket: Record<string, number> }> {
  const rows = await listFeedback({ since: opts?.since, limit: 1000 });
  const filtered = opts?.basket ? rows.filter(r => r.basket === opts.basket) : rows;
  const byKind: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byBasket: Record<string, number> = {};
  for (const row of filtered) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    if (row.action) byAction[row.action] = (byAction[row.action] ?? 0) + 1;
    if (row.basket) byBasket[row.basket] = (byBasket[row.basket] ?? 0) + 1;
  }
  return { total: filtered.length, byKind, byAction, byBasket };
}

function getIntentCardState(cardId: string): IntentCardStateRow | null {
  return getDb().prepare('SELECT * FROM intent_card_state WHERE card_id = ?').get(cardId) as IntentCardStateRow | null;
}

function getIntentThreadState(intentKey: string): IntentThreadStateRow | null {
  return getDb().prepare('SELECT * FROM intent_thread_state WHERE intent_key = ?').get(intentKey) as IntentThreadStateRow | null;
}

function upsertIntentCardState(input: {
  cardId: string;
  intentKey: string;
  goalBasket: string;
  latestOutcome: CardOutcome;
  outcomeAt?: string | null;
  hasDeepChat: boolean;
  latestChatDecision: ChatDecision;
  latestChatSummary?: string | null;
  nextAngles: string[];
  updatedAt: string;
}): void {
  getDb().prepare(`
    INSERT INTO intent_card_state (
      card_id, intent_key, goal_basket, latest_outcome, outcome_at, has_deep_chat,
      latest_chat_decision, latest_chat_summary, next_angles_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET
      intent_key = excluded.intent_key,
      goal_basket = excluded.goal_basket,
      latest_outcome = excluded.latest_outcome,
      outcome_at = excluded.outcome_at,
      has_deep_chat = excluded.has_deep_chat,
      latest_chat_decision = excluded.latest_chat_decision,
      latest_chat_summary = excluded.latest_chat_summary,
      next_angles_json = excluded.next_angles_json,
      updated_at = excluded.updated_at
  `).run(
    input.cardId,
    input.intentKey,
    input.goalBasket,
    input.latestOutcome,
    input.outcomeAt ?? null,
    input.hasDeepChat ? 1 : 0,
    input.latestChatDecision,
    input.latestChatSummary ?? null,
    JSON.stringify(input.nextAngles),
    input.updatedAt,
  );
}

function upsertIntentThreadState(input: {
  intentKey: string;
  goalBasket: string;
  latestCardId?: string | null;
  latestGeneratedAt?: string | null;
  latestCardOutcome: CardOutcome;
  hasAnyConfirmedCard: boolean;
  hasAnyDismissedCard: boolean;
  latestChatDecision: ChatDecision;
  latestChatSummary?: string | null;
  nextAngles: string[];
  threadDecision: ThreadDecision;
  updatedAt: string;
}): void {
  getDb().prepare(`
    INSERT INTO intent_thread_state (
      intent_key, goal_basket, latest_card_id, latest_generated_at, latest_card_outcome,
      has_any_confirmed_card, has_any_dismissed_card, latest_chat_decision,
      latest_chat_summary, next_angles_json, thread_decision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(intent_key) DO UPDATE SET
      goal_basket = excluded.goal_basket,
      latest_card_id = excluded.latest_card_id,
      latest_generated_at = excluded.latest_generated_at,
      latest_card_outcome = excluded.latest_card_outcome,
      has_any_confirmed_card = excluded.has_any_confirmed_card,
      has_any_dismissed_card = excluded.has_any_dismissed_card,
      latest_chat_decision = excluded.latest_chat_decision,
      latest_chat_summary = excluded.latest_chat_summary,
      next_angles_json = excluded.next_angles_json,
      thread_decision = excluded.thread_decision,
      updated_at = excluded.updated_at
  `).run(
    input.intentKey,
    input.goalBasket,
    input.latestCardId ?? null,
    input.latestGeneratedAt ?? null,
    input.latestCardOutcome,
    input.hasAnyConfirmedCard ? 1 : 0,
    input.hasAnyDismissedCard ? 1 : 0,
    input.latestChatDecision,
    input.latestChatSummary ?? null,
    JSON.stringify(input.nextAngles),
    input.threadDecision,
    input.updatedAt,
  );
}

export async function seedGeneratedCards(cards: Array<{
  cardId: string;
  intentKey: string;
  goalBasket: string;
  generatedAt: string;
}>): Promise<void> {
  for (const card of cards) {
    const cardState = getIntentCardState(card.cardId);
    upsertIntentCardState({
      cardId: card.cardId,
      intentKey: card.intentKey,
      goalBasket: card.goalBasket,
      latestOutcome: cardState?.latest_outcome ?? 'none',
      outcomeAt: cardState?.outcome_at ?? null,
      hasDeepChat: Boolean(cardState?.has_deep_chat),
      latestChatDecision: cardState?.latest_chat_decision ?? 'none',
      latestChatSummary: cardState?.latest_chat_summary ?? null,
      nextAngles: parseJsonArray<string>(cardState?.next_angles_json),
      updatedAt: card.generatedAt,
    });

    const threadState = getIntentThreadState(card.intentKey);
    const latestGeneratedAt = !threadState?.latest_generated_at || threadState.latest_generated_at <= card.generatedAt
      ? card.generatedAt
      : threadState.latest_generated_at;
    const latestCardId = !threadState?.latest_generated_at || threadState.latest_generated_at <= card.generatedAt
      ? card.cardId
      : threadState.latest_card_id;
    upsertIntentThreadState({
      intentKey: card.intentKey,
      goalBasket: card.goalBasket,
      latestCardId,
      latestGeneratedAt,
      latestCardOutcome: threadState?.latest_card_outcome ?? 'none',
      hasAnyConfirmedCard: Boolean(threadState?.has_any_confirmed_card),
      hasAnyDismissedCard: Boolean(threadState?.has_any_dismissed_card),
      latestChatDecision: threadState?.latest_chat_decision ?? 'none',
      latestChatSummary: threadState?.latest_chat_summary ?? null,
      nextAngles: parseJsonArray<string>(threadState?.next_angles_json),
      threadDecision: threadState?.thread_decision ?? 'hold',
      updatedAt: card.generatedAt,
    });
  }
}

export async function applyCardOutcome(input: {
  cardId: string;
  intentKey: string;
  goalBasket: string;
  outcome: Exclude<CardOutcome, 'none'>;
  at?: string;
}): Promise<void> {
  const ts = input.at ?? now();
  const cardState = getIntentCardState(input.cardId);
  upsertIntentCardState({
    cardId: input.cardId,
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestOutcome: input.outcome,
    outcomeAt: ts,
    hasDeepChat: Boolean(cardState?.has_deep_chat),
    latestChatDecision: cardState?.latest_chat_decision ?? 'none',
    latestChatSummary: cardState?.latest_chat_summary ?? null,
    nextAngles: parseJsonArray<string>(cardState?.next_angles_json),
    updatedAt: ts,
  });

  const threadState = getIntentThreadState(input.intentKey);
  const latestChatDecision = threadState?.latest_chat_decision ?? 'none';
  upsertIntentThreadState({
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestCardId: input.cardId,
    latestGeneratedAt: threadState?.latest_generated_at ?? null,
    latestCardOutcome: input.outcome,
    hasAnyConfirmedCard: Boolean(threadState?.has_any_confirmed_card) || input.outcome === 'confirm',
    hasAnyDismissedCard: Boolean(threadState?.has_any_dismissed_card) || input.outcome === 'dismiss',
    latestChatDecision,
    latestChatSummary: threadState?.latest_chat_summary ?? null,
    nextAngles: parseJsonArray<string>(threadState?.next_angles_json),
    threadDecision: deriveThreadDecision(input.outcome, latestChatDecision),
    updatedAt: ts,
  });
}

export async function applyChatDecision(input: {
  cardId: string;
  intentKey: string;
  goalBasket: string;
  decision: Exclude<ChatDecision, 'none'>;
  summary: string;
  nextAngles: string[];
  at?: string;
}): Promise<void> {
  const ts = input.at ?? now();
  const cardState = getIntentCardState(input.cardId);
  upsertIntentCardState({
    cardId: input.cardId,
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestOutcome: cardState?.latest_outcome ?? 'none',
    outcomeAt: cardState?.outcome_at ?? null,
    hasDeepChat: true,
    latestChatDecision: input.decision,
    latestChatSummary: input.summary,
    nextAngles: input.nextAngles,
    updatedAt: ts,
  });

  const threadState = getIntentThreadState(input.intentKey);
  upsertIntentThreadState({
    intentKey: input.intentKey,
    goalBasket: input.goalBasket,
    latestCardId: threadState?.latest_card_id ?? input.cardId,
    latestGeneratedAt: threadState?.latest_generated_at ?? null,
    latestCardOutcome: threadState?.latest_card_outcome ?? 'none',
    hasAnyConfirmedCard: Boolean(threadState?.has_any_confirmed_card),
    hasAnyDismissedCard: Boolean(threadState?.has_any_dismissed_card),
    latestChatDecision: input.decision,
    latestChatSummary: input.summary,
    nextAngles: input.nextAngles,
    threadDecision: input.decision,
    updatedAt: ts,
  });
}

export async function getThreadContext(intentKey: string): Promise<ThreadContext> {
  const row = getIntentThreadState(intentKey);
  if (!row) return defaultThreadContext(intentKey);
  return {
    intentKey: row.intent_key,
    latestCardOutcome: row.latest_card_outcome,
    hasAnyConfirmedCard: Boolean(row.has_any_confirmed_card),
    hasAnyDismissedCard: Boolean(row.has_any_dismissed_card),
    latestChatDecision: row.latest_chat_decision,
    latestChatSummary: row.latest_chat_summary ?? null,
    nextAngles: parseJsonArray<string>(row.next_angles_json),
    threadDecision: row.thread_decision,
  };
}

// ── World Signals (formerly world_items) ──
// See docs/plans/memory-architecture.mdx §三 (world_signals).

export interface WorldSignalRow {
  id: string;
  provider: string;
  stream_type: string;
  title: string;
  url: string;
  normalized_url: string;
  external_id: string | null;
  summary: string | null;
  published_at: string | null;
  search_queries: string[];
  topics: string[];
  regions: string[];
  importance: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToWorldSignal(row: any): WorldSignalRow {
  return {
    ...row,
    search_queries: parseJsonArray<string>(row.search_queries),
    topics: parseJsonArray<string>(row.topics),
    regions: parseJsonArray<string>(row.regions),
    metadata: parseJson(row.metadata),
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export async function ingestWorldSignal(input: {
  provider: string;
  streamType?: string;
  title: string;
  url: string;
  normalizedUrl: string;
  externalId?: string;
  summary?: string;
  publishedAt?: string;
  searchQueries?: string[];
  topics?: string[];
  regions?: string[];
  importance?: string;
  metadata?: Record<string, unknown>;
}): Promise<WorldSignalRow> {
  const db = getDb();
  const id = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO world_signals (id, provider, stream_type, title, url, normalized_url, external_id, summary, published_at,
      search_queries, topics, regions, importance, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_url) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      published_at = excluded.published_at,
      search_queries = excluded.search_queries,
      topics = excluded.topics,
      regions = excluded.regions,
      importance = excluded.importance,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `).run(id, input.provider, input.streamType ?? 'search', input.title, input.url, input.normalizedUrl,
    input.externalId ?? null, input.summary ?? null, input.publishedAt ?? null,
    JSON.stringify(input.searchQueries ?? []), JSON.stringify(input.topics ?? []),
    JSON.stringify(input.regions ?? []), input.importance ?? null,
    JSON.stringify(input.metadata ?? {}), ts, ts);
  const row = db.prepare('SELECT * FROM world_signals WHERE normalized_url = ?').get(input.normalizedUrl) as any;
  return rowToWorldSignal(row);
}
export async function listWorldSignals(opts?: {
  query?: string;
  provider?: string;
  since?: string;
  limit?: number;
}): Promise<WorldSignalRow[]> {
  const parts = ['SELECT * FROM world_signals WHERE 1=1'];
  const params: unknown[] = [];
  if (opts?.query) { parts.push('AND title LIKE ?'); params.push(`%${opts.query}%`); }
  if (opts?.provider) { parts.push('AND provider = ?'); params.push(opts.provider); }
  if (opts?.since) { parts.push('AND published_at >= ?'); params.push(opts.since); }
  parts.push('ORDER BY COALESCE(published_at, created_at) DESC');
  if (opts?.limit) { parts.push('LIMIT ?'); params.push(opts.limit); }
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToWorldSignal);
}
export async function getWorldSignal(id: string): Promise<WorldSignalRow | null> {
  const row = getDb().prepare('SELECT * FROM world_signals WHERE id = ?').get(id) as any;
  return row ? rowToWorldSignal(row) : null;
}
export async function listWorldSignalsByIds(ids: string[]): Promise<WorldSignalRow[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM world_signals WHERE id IN (${placeholders})`).all(...ids) as any[];
  const mapped = rows.map(rowToWorldSignal);
  // Preserve input order
  const order = new Map(ids.map((id, i) => [id, i]));
  return mapped.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
/**
 * Bump reference_count + dedup-append runId to referenced_by_runs (cap 10)
 * for the given world_signals rows. Mirrors markMemoryReferenced API.
 */
export async function markWorldSignalsReferenced(
  signalIds: string[],
  runId: string,
): Promise<number> {
  if (!runId || signalIds.length === 0) return 0;
  let updated = 0;
  const ts = now();
  const tx = getDb().transaction(() => {
    for (const id of signalIds) {
      const row = getDb().prepare(
        'SELECT referenced_by_runs FROM world_signals WHERE id = ?',
      ).get(id) as { referenced_by_runs?: string } | undefined;
      if (!row) continue;
      const existing = parseJsonArray<string>(row.referenced_by_runs);
      const nextRuns = existing.includes(runId)
        ? existing
        : [...existing.slice(-(REFERENCED_BY_RUNS_CAP - 1)), runId];
      getDb().prepare(
        `UPDATE world_signals
         SET reference_count = reference_count + 1,
             last_referenced_at = ?,
             referenced_by_runs = ?
         WHERE id = ?`,
      ).run(ts, JSON.stringify(nextRuns), id);
      updated += 1;
    }
  });
  tx();
  return updated;
}

export interface WorldSemanticCandidate extends WorldSignalRow {
  searchText: string;
}

export async function listSemanticIndexCandidates(opts?: { limit?: number }): Promise<WorldSemanticCandidate[]> {
  const items = await listWorldSignals({ limit: opts?.limit ?? 100 });
  return items.map(item => ({
    ...item,
    searchText: [
      item.title,
      item.summary ?? '',
      ...(item.topics ?? []),
      ...(item.regions ?? []),
      ...(item.search_queries ?? []),
      item.provider,
      item.stream_type,
      item.importance ?? '',
    ].join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

// ── Pipeline Runs ──

export interface PipelineRunRow {
  id: string;
  user_id: string;
  run_id: string;
  status: string;
  total_iterations: number | null;
  final_cards: unknown;
  iterations: unknown;
  artifact_path: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface RecentGeneratedCardRow {
  runId: string;
  cardId: string;
  intentKey: string;
  goalBasket: string | null;
  title: string | null;
  titleKey: string | null;
  whyNow: string | null;
  summary: string | null;
  primaryActionLabel: string | null;
  sources: string[];
  generatedAt: string | null;
  metadata: Record<string, unknown>;
  threadContext: ThreadContext;
}

function rowToPipelineRun(row: any): PipelineRunRow {
  return {
    ...row,
    user_id: USER_ID,
    final_cards: row.final_cards ? parseJson(row.final_cards) : null,
    iterations: row.iterations ? parseJson(row.iterations) : null,
    artifact_path: row.artifact_path ?? null,
  };
}

/**
 * Resolve the directory where pipeline iteration artifacts (large JSON blobs)
 * are persisted. See docs/plans/memory-architecture.mdx §五 (大 JSON 不进 SQLite).
 */
export function getRunArtifactsDir(): string {
  const home = process.env.OPENCLAW_HOME || '/app';
  return path.join(home, 'data', 'run-artifacts');
}

export function getRunArtifactPath(runId: string): string {
  return path.join(getRunArtifactsDir(), `${runId}.json`);
}

/**
 * Read the iterations payload that was previously persisted to the artifact
 * file for `runId`. Returns null if the file does not exist or fails to parse.
 */
export function readRunArtifact(runId: string): unknown | null {
  try {
    const raw = fs.readFileSync(getRunArtifactPath(runId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function savePipelineRun(input: {
  runId: string;
  status: string;
  totalIterations: number;
  finalCards: unknown;
  iterations: unknown;
}): Promise<void> {
  const id = genId();
  const ts = now();

  // Persist large iterations blob to filesystem; keep DB row lean.
  let artifactPath: string | null = null;
  let iterationsForDb: string | null = null;
  if (input.iterations !== undefined && input.iterations !== null) {
    const dir = getRunArtifactsDir();
    fs.mkdirSync(dir, { recursive: true });
    artifactPath = getRunArtifactPath(input.runId);
    fs.writeFileSync(artifactPath, JSON.stringify(input.iterations));
    // Iterations column is left NULL — readers should consult artifact_path.
  }

  getDb().prepare(
    `INSERT INTO pipeline_runs
       (id, run_id, status, total_iterations, final_cards, iterations, artifact_path, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.runId, input.status, input.totalIterations,
    JSON.stringify(input.finalCards), iterationsForDb, artifactPath, ts, ts,
  );
  const cards = Array.isArray(input.finalCards) ? input.finalCards as Array<Record<string, unknown>> : [];
  await seedGeneratedCards(cards.flatMap((card) => {
    const cardId = typeof card.id === 'string' && card.id.trim().length > 0 ? card.id.trim() : null;
    const goalBasket = typeof card.goalBasket === 'string' ? card.goalBasket : null;
    const title = typeof card.title === 'string' ? card.title : null;
    if (!cardId || !goalBasket || !title) return [];
    return [{
      cardId,
      intentKey: makeIntentKey(goalBasket, title),
      goalBasket,
      generatedAt: ts,
    }];
  }));
}

export async function getLatestPipelineRun(): Promise<PipelineRunRow | null> {
  const row = getDb().prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1').get() as any;
  return row ? rowToPipelineRun(row) : null;
}

export async function listPipelineRuns(opts?: { since?: string; limit?: number }): Promise<PipelineRunRow[]> {
  const parts = ['SELECT * FROM pipeline_runs WHERE 1=1'];
  const params: unknown[] = [];
  if (opts?.since) { parts.push('AND started_at >= ?'); params.push(opts.since); }
  parts.push('ORDER BY started_at DESC LIMIT ?');
  params.push(opts?.limit ?? 30);
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToPipelineRun);
}

export async function listRecentGeneratedCards(opts?: {
  since?: string;
  limit?: number;
  basket?: string;
}): Promise<RecentGeneratedCardRow[]> {
  const runs = await listPipelineRuns({
    since: opts?.since,
    limit: 50,
  });
  const seen = new Set<string>();
  const records: RecentGeneratedCardRow[] = [];

  for (const run of runs) {
    const cards = Array.isArray(run.final_cards) ? run.final_cards as Array<Record<string, unknown>> : [];
    for (const card of cards) {
      const cardId = typeof card.id === 'string' && card.id.trim().length > 0
        ? card.id.trim()
        : null;
      if (!cardId) continue;
      const key = `${run.run_id}:${cardId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const goalBasket = typeof card.goalBasket === 'string' ? card.goalBasket : null;
      if (opts?.basket && goalBasket !== opts.basket) continue;
      const title = typeof card.title === 'string' ? card.title : null;
      const intentKey = title && goalBasket ? makeIntentKey(goalBasket, title) : `unknown:${cardId}`;
      const summary = typeof card.summary === 'string' ? card.summary : null;
      const whyNow = typeof card.whyNow === 'string' ? card.whyNow : null;
      const primaryAction = card.primaryAction && typeof card.primaryAction === 'object'
        ? card.primaryAction as { label?: unknown }
        : null;
      const sources = Array.isArray(card.sources)
        ? card.sources.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      const metadata: Record<string, unknown> = {
        agentChain: Array.isArray(card.agentChain) ? card.agentChain : [],
        confidence: typeof card.confidence === 'number' ? card.confidence : null,
        urgency: typeof card.urgency === 'number' ? card.urgency : null,
        importance: typeof card.importance === 'number' ? card.importance : null,
        cardCreatedAt: typeof card.createdAt === 'string' ? card.createdAt : null,
      };

      records.push({
        runId: run.run_id,
        cardId,
        intentKey,
        goalBasket,
        title,
        titleKey: title ? makeTitleKey(title) : null,
        whyNow,
        summary,
        primaryActionLabel: typeof primaryAction?.label === 'string' ? primaryAction.label : null,
        sources,
        generatedAt: run.completed_at ?? run.started_at,
        metadata,
        threadContext: await getThreadContext(intentKey),
      });

      if (records.length >= (opts?.limit ?? 10)) {
        return records;
      }
    }
  }

  return records;
}

export async function getRecentGeneratedCardByCardId(cardId: string): Promise<RecentGeneratedCardRow | null> {
  const rows = await listRecentGeneratedCards({ limit: 200 });
  return rows.find((row) => row.cardId === cardId) ?? null;
}

// ── User Settings ──

export interface UserSettingsRow {
  user_id: string;
  generation_language: string;
  auto_generate: boolean;
  auto_dreaming: boolean;
  auto_crystallize: boolean;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export async function getUserSettings(): Promise<UserSettingsRow> {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO user_settings (id, updated_at) VALUES (1, ?)").run(now());
  const row = db.prepare('SELECT * FROM user_settings WHERE id = 1').get() as any;
  const autoCrystallizeRaw = row.auto_crystallize;
  return {
    user_id: USER_ID,
    generation_language: row.generation_language,
    auto_generate: Boolean(row.auto_generate),
    auto_dreaming: Boolean(row.auto_dreaming),
    auto_crystallize: autoCrystallizeRaw === undefined || autoCrystallizeRaw === null
      ? true
      : Boolean(autoCrystallizeRaw),
    metadata: parseJson(row.metadata),
    updated_at: row.updated_at,
  };
}

export async function updateUserSettings(
  fields: Partial<Pick<UserSettingsRow,
    'generation_language' | 'auto_generate' | 'auto_dreaming' | 'auto_crystallize' | 'metadata'>>,
): Promise<void> {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.generation_language !== undefined) { sets.push('generation_language = ?'); vals.push(fields.generation_language); }
  if (fields.auto_generate !== undefined) { sets.push('auto_generate = ?'); vals.push(fields.auto_generate ? 1 : 0); }
  if (fields.auto_dreaming !== undefined) { sets.push('auto_dreaming = ?'); vals.push(fields.auto_dreaming ? 1 : 0); }
  if (fields.auto_crystallize !== undefined) { sets.push('auto_crystallize = ?'); vals.push(fields.auto_crystallize ? 1 : 0); }
  if (fields.metadata !== undefined) { sets.push('metadata = ?'); vals.push(JSON.stringify(fields.metadata)); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?'); vals.push(now());
  // Ensure row exists
  db.prepare("INSERT OR IGNORE INTO user_settings (id, updated_at) VALUES (1, ?)").run(now());
  db.prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
}

// ── Chat Crystallize State (KV-backed in app_state['crystallize.state']) ──
// Phase 15: collapsed from a single-row table into the app_state KV. The
// migration runs on every container start (idempotent). See
// docs/memory-architecture.md §八 Phase 15.

export interface ChatCrystallizeStateRow {
  turn_count: number;
  last_crystallized_at: string | null;
  last_session_key: string | null;
  last_message_at: string | null;
  updated_at: string;
}

const CRYSTALLIZE_NS = 'crystallize';
const CRYSTALLIZE_KEY = 'state';

function emptyCrystallizeState(ts: string): ChatCrystallizeStateRow {
  return {
    turn_count: 0,
    last_crystallized_at: null,
    last_session_key: null,
    last_message_at: null,
    updated_at: ts,
  };
}

export async function getCrystallizeState(): Promise<ChatCrystallizeStateRow> {
  const stored = await getAppState<ChatCrystallizeStateRow>(CRYSTALLIZE_NS, CRYSTALLIZE_KEY);
  return stored ?? emptyCrystallizeState(now());
}

export async function bumpCrystallizeTurn(sessionKey: string): Promise<ChatCrystallizeStateRow> {
  const ts = now();
  const current = await getCrystallizeState();
  const next: ChatCrystallizeStateRow = {
    turn_count: current.turn_count + 1,
    last_crystallized_at: current.last_crystallized_at,
    last_session_key: sessionKey,
    last_message_at: ts,
    updated_at: ts,
  };
  await setAppState(CRYSTALLIZE_NS, CRYSTALLIZE_KEY, next);
  return next;
}

export async function markCrystallized(): Promise<void> {
  const ts = now();
  const current = await getCrystallizeState();
  const next: ChatCrystallizeStateRow = {
    turn_count: 0,
    last_crystallized_at: ts,
    last_session_key: current.last_session_key,
    last_message_at: current.last_message_at,
    updated_at: ts,
  };
  await setAppState(CRYSTALLIZE_NS, CRYSTALLIZE_KEY, next);
}

/**
 * Tunable crystallize config overrides — persisted in user_settings.metadata
 * under the `crystallize` key so we don't add a new column. Only contains
 * keys the user is allowed to tune (see TUNABLE_CRYSTALLIZE_KEYS in the
 * conversation-crystallize/types module).
 */
export async function getCrystallizeOverride(): Promise<Record<string, number>> {
  const settings = await getUserSettings();
  const raw = settings.metadata?.crystallize;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export async function setCrystallizeOverride(
  patch: Record<string, number | null>,
): Promise<Record<string, number>> {
  const settings = await getUserSettings();
  const metadata = { ...(settings.metadata ?? {}) };
  const existing = (metadata.crystallize && typeof metadata.crystallize === 'object'
    ? (metadata.crystallize as Record<string, unknown>)
    : {}) as Record<string, number>;
  const next: Record<string, number> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete next[k];
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      next[k] = v;
    }
  }
  metadata.crystallize = next;
  await updateUserSettings({ metadata });
  return next;
}

// ── User Skills ──
// Adapted to the v3 skill_index + skills/<id>/SKILL.md folder. The legacy
// user_skills table is migrated by migrateLegacyToV3 and dropped. We
// preserve the v2 UserSkillRow shape so existing callers (cli/profile.ts,
// routes/skills.ts, conversation-crystallize/skill-injection.ts,
// routes/crystallize.ts) compile without changes.

export interface UserSkillRow {
  id: string;
  title: string;
  body_md: string;
  triggers: string[];
  source: string;
  status: 'active' | 'disabled';
  source_summary: string | null;
  created_at: string;
  updated_at: string;
}

function v3SkillStatusToLegacy(s: SkillStatus): 'active' | 'disabled' {
  return s === 'enabled' ? 'active' : 'disabled';
}

function v3SkillToLegacyRow(row: SkillIndexRow): UserSkillRow {
  return {
    id: row.id,
    title: row.title,
    body_md: readSkillBody(row.id) ?? '',
    triggers: row.triggers,
    source: row.source,
    status: v3SkillStatusToLegacy(row.status),
    source_summary: row.description ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUserSkills(opts?: {
  status?: 'active' | 'disabled';
  limit?: number;
}): Promise<UserSkillRow[]> {
  const v3Status: SkillStatus | undefined = opts?.status === 'active' ? 'enabled'
    : opts?.status === 'disabled' ? 'disabled' : undefined;
  const rows = await listSkills({ status: v3Status, limit: opts?.limit ?? 200 });
  return rows.map(v3SkillToLegacyRow);
}

export async function getUserSkill(id: string): Promise<UserSkillRow | null> {
  const row = await getSkillIndex(id);
  return row ? v3SkillToLegacyRow(row) : null;
}

export async function addUserSkill(input: {
  title: string;
  body_md: string;
  triggers?: string[];
  source: string;
  status?: 'active' | 'disabled';
  source_summary?: string | null;
}): Promise<UserSkillRow> {
  const id = genId();
  const status: SkillStatus = (input.status ?? 'active') === 'active' ? 'enabled' : 'disabled';
  const v3 = await addSkill({
    id,
    title: input.title,
    body: input.body_md,
    description: input.source_summary ?? null,
    triggers: input.triggers ?? [],
    source: input.source,
    status,
  });
  return v3SkillToLegacyRow(v3);
}

export async function updateUserSkill(
  id: string,
  patch: Partial<Pick<UserSkillRow, 'title' | 'body_md' | 'triggers' | 'status' | 'source_summary'>>,
): Promise<UserSkillRow | null> {
  const existing = await getSkillIndex(id);
  if (!existing) return null;
  if (patch.status !== undefined) {
    if (patch.status === 'disabled' && existing.status === 'enabled') await disableSkill(id);
    else if (patch.status === 'active' && existing.status !== 'enabled') await enableSkill(id);
  }
  const v3 = await updateSkill({
    id,
    title: patch.title,
    description: patch.source_summary,
    body: patch.body_md,
    triggers: patch.triggers,
  });
  return v3SkillToLegacyRow(v3);
}

export async function deleteUserSkill(id: string): Promise<boolean> {
  // Hard delete: removes the index row + the body file. v3 prefers
  // disable+archive for normal flow, but the legacy DELETE /skills/:id
  // route expects the row to actually disappear.
  const existing = await getSkillIndex(id);
  if (!existing) return false;
  const info = getDb().prepare('DELETE FROM skill_index WHERE id = ?').run(id);
  try {
    fs.rmSync(getSkillFolder(id), { recursive: true, force: true });
  } catch { /* folder may not exist */ }
  return info.changes > 0;
}

// ── Auto-Loop State (KV-backed in app_state['scheduler.autoLoopState']) ──
// Phase 15: collapsed from a single-row table into the app_state KV. The
// migration runs on every container start (idempotent). See
// docs/memory-architecture.md §八 Phase 15.

export interface AutoLoopStateRow {
  user_id: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  updated_at: string;
}

interface AutoLoopStateValue {
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  updated_at: string;
}

const AUTO_LOOP_NS = 'scheduler';
const AUTO_LOOP_KEY = 'autoLoopState';

function emptyAutoLoopValue(ts: string): AutoLoopStateValue {
  return { last_started_at: null, last_finished_at: null, last_status: null, updated_at: ts };
}

export async function getAutoLoopState(): Promise<AutoLoopStateRow> {
  const stored = await getAppState<AutoLoopStateValue>(AUTO_LOOP_NS, AUTO_LOOP_KEY);
  const value = stored ?? emptyAutoLoopValue(now());
  return {
    user_id: USER_ID,
    last_started_at: value.last_started_at,
    last_finished_at: value.last_finished_at,
    last_status: value.last_status,
    updated_at: value.updated_at,
  };
}

export async function saveAutoLoopState(
  fields: Partial<Pick<AutoLoopStateRow, 'last_started_at' | 'last_finished_at' | 'last_status'>>,
): Promise<void> {
  const ts = now();
  const current = (await getAppState<AutoLoopStateValue>(AUTO_LOOP_NS, AUTO_LOOP_KEY)) ?? emptyAutoLoopValue(ts);
  const next: AutoLoopStateValue = {
    last_started_at: fields.last_started_at !== undefined ? fields.last_started_at : current.last_started_at,
    last_finished_at: fields.last_finished_at !== undefined ? fields.last_finished_at : current.last_finished_at,
    last_status: fields.last_status !== undefined ? fields.last_status : current.last_status,
    updated_at: ts,
  };
  await setAppState(AUTO_LOOP_NS, AUTO_LOOP_KEY, next);
}

// ── App State (KV) — replaces auto_loop_state / chat_crystallize_state /
//                    ingest_cursor / pending_items / context_runs single-row tables.
// See docs/plans/memory-architecture.mdx §五 (app_state KV).

export interface AppStateRow<T = unknown> {
  namespace: string;
  key: string;
  value: T;
  updated_at: string;
}

export async function getAppState<T = unknown>(
  namespace: string,
  key: string,
): Promise<T | null> {
  const row = getDb()
    .prepare('SELECT value_json FROM app_state WHERE namespace = ? AND key = ?')
    .get(namespace, key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export async function setAppState<T = unknown>(
  namespace: string,
  key: string,
  value: T,
): Promise<void> {
  const json = JSON.stringify(value ?? null);
  getDb()
    .prepare(
      `INSERT INTO app_state (namespace, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(namespace, key, json, now());
}

export async function deleteAppState(namespace: string, key: string): Promise<void> {
  getDb().prepare('DELETE FROM app_state WHERE namespace = ? AND key = ?').run(namespace, key);
}

export async function listAppState<T = unknown>(
  namespace: string,
): Promise<AppStateRow<T>[]> {
  const rows = getDb()
    .prepare('SELECT namespace, key, value_json, updated_at FROM app_state WHERE namespace = ? ORDER BY key')
    .all(namespace) as Array<{ namespace: string; key: string; value_json: string; updated_at: string }>;
  return rows.map((row) => {
    let value: T;
    try {
      value = JSON.parse(row.value_json) as T;
    } catch {
      value = null as T;
    }
    return { namespace: row.namespace, key: row.key, value, updated_at: row.updated_at };
  });
}

// ── Card Evaluations — pipeline self-review scores. Indexable for evals.
// See docs/plans/memory-architecture.mdx §三 (card_evaluations).

export interface CardEvaluationRow {
  card_id: string;
  run_id: string;
  intent_key: string | null;
  basket: string | null;
  dim_relevance: number | null;
  dim_actionability: number | null;
  dim_why_now: number | null;
  dim_novelty: number | null;
  dim_decision_compress: number | null;
  overall: number | null;
  pass: boolean;
  evaluator: string;
  feedback_text: string | null;
  evaluated_at: string;
}

export interface SaveCardEvaluationInput {
  cardId: string;
  runId: string;
  intentKey?: string | null;
  basket?: string | null;
  dimensions?: {
    relevance?: number;
    actionability?: number;
    whyNow?: number;
    novelty?: number;
    decisionCompression?: number;
  };
  overall?: number;
  pass?: boolean;
  evaluator?: string;
  feedbackText?: string | null;
}

export async function saveCardEvaluation(
  input: SaveCardEvaluationInput,
): Promise<CardEvaluationRow> {
  const ts = now();
  const evaluator = input.evaluator ?? 'self';
  const dims = input.dimensions ?? {};
  const pass = input.pass ?? true;
  getDb()
    .prepare(
      `INSERT INTO card_evaluations (
         card_id, run_id, intent_key, basket,
         dim_relevance, dim_actionability, dim_why_now, dim_novelty, dim_decision_compress,
         overall, pass, evaluator, feedback_text, evaluated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         run_id = excluded.run_id,
         intent_key = excluded.intent_key,
         basket = excluded.basket,
         dim_relevance = excluded.dim_relevance,
         dim_actionability = excluded.dim_actionability,
         dim_why_now = excluded.dim_why_now,
         dim_novelty = excluded.dim_novelty,
         dim_decision_compress = excluded.dim_decision_compress,
         overall = excluded.overall,
         pass = excluded.pass,
         evaluator = excluded.evaluator,
         feedback_text = excluded.feedback_text,
         evaluated_at = excluded.evaluated_at`,
    )
    .run(
      input.cardId,
      input.runId,
      input.intentKey ?? null,
      input.basket ?? null,
      dims.relevance ?? null,
      dims.actionability ?? null,
      dims.whyNow ?? null,
      dims.novelty ?? null,
      dims.decisionCompression ?? null,
      input.overall ?? null,
      pass ? 1 : 0,
      evaluator,
      input.feedbackText ?? null,
      ts,
    );
  return {
    card_id: input.cardId,
    run_id: input.runId,
    intent_key: input.intentKey ?? null,
    basket: input.basket ?? null,
    dim_relevance: dims.relevance ?? null,
    dim_actionability: dims.actionability ?? null,
    dim_why_now: dims.whyNow ?? null,
    dim_novelty: dims.novelty ?? null,
    dim_decision_compress: dims.decisionCompression ?? null,
    overall: input.overall ?? null,
    pass,
    evaluator,
    feedback_text: input.feedbackText ?? null,
    evaluated_at: ts,
  };
}

export async function saveCardEvaluations(
  inputs: SaveCardEvaluationInput[],
): Promise<CardEvaluationRow[]> {
  if (inputs.length === 0) return [];
  const out: CardEvaluationRow[] = [];
  const tx = getDb().transaction((batch: SaveCardEvaluationInput[]) => {
    for (const item of batch) {
      // saveCardEvaluation is async-shaped but the underlying op is sync;
      // fire-and-await is safe inside a sync transaction since it returns a resolved promise.
      out.push({
        card_id: item.cardId,
        run_id: item.runId,
        intent_key: item.intentKey ?? null,
        basket: item.basket ?? null,
        dim_relevance: item.dimensions?.relevance ?? null,
        dim_actionability: item.dimensions?.actionability ?? null,
        dim_why_now: item.dimensions?.whyNow ?? null,
        dim_novelty: item.dimensions?.novelty ?? null,
        dim_decision_compress: item.dimensions?.decisionCompression ?? null,
        overall: item.overall ?? null,
        pass: item.pass ?? true,
        evaluator: item.evaluator ?? 'self',
        feedback_text: item.feedbackText ?? null,
        evaluated_at: now(),
      });
    }
    for (const row of out) {
      getDb()
        .prepare(
          `INSERT INTO card_evaluations (
             card_id, run_id, intent_key, basket,
             dim_relevance, dim_actionability, dim_why_now, dim_novelty, dim_decision_compress,
             overall, pass, evaluator, feedback_text, evaluated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(card_id) DO UPDATE SET
             run_id = excluded.run_id,
             intent_key = excluded.intent_key,
             basket = excluded.basket,
             dim_relevance = excluded.dim_relevance,
             dim_actionability = excluded.dim_actionability,
             dim_why_now = excluded.dim_why_now,
             dim_novelty = excluded.dim_novelty,
             dim_decision_compress = excluded.dim_decision_compress,
             overall = excluded.overall,
             pass = excluded.pass,
             evaluator = excluded.evaluator,
             feedback_text = excluded.feedback_text,
             evaluated_at = excluded.evaluated_at`,
        )
        .run(
          row.card_id,
          row.run_id,
          row.intent_key,
          row.basket,
          row.dim_relevance,
          row.dim_actionability,
          row.dim_why_now,
          row.dim_novelty,
          row.dim_decision_compress,
          row.overall,
          row.pass ? 1 : 0,
          row.evaluator,
          row.feedback_text,
          row.evaluated_at,
        );
    }
  });
  tx(inputs);
  return out;
}

function rowToCardEvaluation(row: any): CardEvaluationRow {
  return {
    card_id: row.card_id,
    run_id: row.run_id,
    intent_key: row.intent_key,
    basket: row.basket,
    dim_relevance: row.dim_relevance,
    dim_actionability: row.dim_actionability,
    dim_why_now: row.dim_why_now,
    dim_novelty: row.dim_novelty,
    dim_decision_compress: row.dim_decision_compress,
    overall: row.overall,
    pass: row.pass === 1 || row.pass === true,
    evaluator: row.evaluator,
    feedback_text: row.feedback_text,
    evaluated_at: row.evaluated_at,
  };
}

export async function listCardEvaluationsByRun(runId: string): Promise<CardEvaluationRow[]> {
  const rows = getDb()
    .prepare('SELECT * FROM card_evaluations WHERE run_id = ? ORDER BY overall DESC')
    .all(runId) as any[];
  return rows.map(rowToCardEvaluation);
}

export async function getCardEvaluation(cardId: string): Promise<CardEvaluationRow | null> {
  const row = getDb()
    .prepare('SELECT * FROM card_evaluations WHERE card_id = ?')
    .get(cardId) as any;
  return row ? rowToCardEvaluation(row) : null;
}

// (legacy PendingStore / ContextRun helpers removed in Phase 1.
//  See docs/plans/memory-architecture.mdx §七 for the migration map.)

// ─────────────────────────────────────────────────────────────────────────
// v3 Memory — sedimented user-fact layer.
// See docs/plans/memory-architecture.mdx §三 (memory).
// ─────────────────────────────────────────────────────────────────────────

export type MemoryStatus = 'active' | 'archived' | 'superseded';

export interface MemoryRowV3 {
  id: string;
  text: string;
  source: string;
  source_run_id: string | null;
  subject: string | null;
  quality: number;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  occurred_at: string | null;
  created_at: string;
  tags: string[];
  related_memory_ids: string[];
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface AddMemoryInput {
  text: string;
  source: string;
  sourceRunId?: string | null;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  occurredAt?: string | null;
  tags?: string[];
  relatedMemoryIds?: string[];
  /** Optional explicit id; if omitted a UUID is generated. */
  id?: string;
}

const MEMORY_QUALITY_DEVICE_TRIGGER_CAP = 0.7;

function clampQuality(source: string, quality: number | undefined): number {
  const q = typeof quality === 'number' && Number.isFinite(quality) ? quality : 0.5;
  // Enforce the device:trigger cap from docs/plans/memory-architecture.mdx §五.
  if (source.startsWith('device:trigger') && q > MEMORY_QUALITY_DEVICE_TRIGGER_CAP) {
    return MEMORY_QUALITY_DEVICE_TRIGGER_CAP;
  }
  return Math.max(0, Math.min(1, q));
}

function rowToMemoryV3(row: any): MemoryRowV3 {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    source_run_id: row.source_run_id ?? null,
    subject: row.subject ?? null,
    quality: typeof row.quality === 'number' ? row.quality : 0.5,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
    status: row.status as MemoryStatus,
    superseded_by: row.superseded_by ?? null,
    occurred_at: row.occurred_at ?? null,
    created_at: row.created_at,
    tags: parseJsonArray<string>(row.tags_json),
    related_memory_ids: parseJsonArray<string>(row.related_memory_ids),
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export async function addMemoryV3(input: AddMemoryInput): Promise<MemoryRowV3> {
  if (!input.text || !input.text.trim()) {
    throw new Error('addMemoryV3: text is required');
  }
  if (!input.source || !input.source.trim()) {
    throw new Error('addMemoryV3: source is required');
  }
  const id = input.id ?? genId();
  const ts = now();
  const quality = clampQuality(input.source, input.quality);
  const confidence = typeof input.confidence === 'number'
    ? Math.max(0, Math.min(1, input.confidence)) : 0.5;
  const tagsJson = JSON.stringify(input.tags ?? []);
  const relatedJson = JSON.stringify(input.relatedMemoryIds ?? []);
  getDb().prepare(
    `INSERT INTO memory (
       id, text, source, source_run_id, subject, quality, confidence,
       status, superseded_by, occurred_at, created_at,
       tags_json, related_memory_ids,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, 0, NULL, '[]')`,
  ).run(
    id, input.text.trim(), input.source, input.sourceRunId ?? null, input.subject ?? null,
    quality, confidence, input.occurredAt ?? null, ts, tagsJson, relatedJson,
  );
  const row = getDb().prepare('SELECT * FROM memory WHERE id = ?').get(id);
  return rowToMemoryV3(row);
}

export interface ListMemoryOpts {
  status?: MemoryStatus;
  minQuality?: number;
  source?: string;
  subject?: string;
  subjectPrefix?: string;
  since?: string;
  until?: string;
  /**
   * Case-insensitive substring match against `text`, `subject`, and
   * `tags_json`. Pushed into SQL so `limit` applies after filtering (the
   * old JS-side filter silently lost matches ranked past the prefetch cap).
   */
  textQuery?: string;
  limit?: number;
  orderBy?: 'created_at' | 'quality' | 'last_referenced_at';
  orderDirection?: 'asc' | 'desc';
}

export async function listMemoryV3(opts: ListMemoryOpts = {}): Promise<MemoryRowV3[]> {
  const parts = ['SELECT * FROM memory WHERE 1=1'];
  const params: unknown[] = [];
  parts.push("AND status = ?");
  params.push(opts.status ?? 'active');
  if (typeof opts.minQuality === 'number') { parts.push('AND quality >= ?'); params.push(opts.minQuality); }
  if (opts.source) { parts.push('AND source = ?'); params.push(opts.source); }
  if (opts.subject) { parts.push('AND subject = ?'); params.push(opts.subject); }
  if (opts.subjectPrefix) {
    parts.push("AND subject LIKE ? ESCAPE '\\'");
    params.push(`${opts.subjectPrefix.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  }
  if (opts.since) { parts.push('AND created_at >= ?'); params.push(opts.since); }
  if (opts.until) { parts.push('AND created_at <= ?'); params.push(opts.until); }
  if (opts.textQuery) {
    const pat = `%${opts.textQuery.replace(/[\\%_]/g, (c) => '\\' + c).toLowerCase()}%`;
    parts.push(`AND (
      LOWER(text) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(subject, '')) LIKE ? ESCAPE '\\'
      OR LOWER(tags_json) LIKE ? ESCAPE '\\'
    )`);
    params.push(pat, pat, pat);
  }
  const orderCol = opts.orderBy === 'quality' ? 'quality'
    : opts.orderBy === 'last_referenced_at' ? 'last_referenced_at'
    : 'created_at';
  const orderDir = opts.orderDirection === 'asc' ? 'ASC' : 'DESC';
  parts.push(`ORDER BY ${orderCol} ${orderDir}`);
  parts.push('LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToMemoryV3);
}

export async function getMemoryV3(id: string): Promise<MemoryRowV3 | null> {
  const row = getDb().prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
  return row ? rowToMemoryV3(row) : null;
}

/**
 * Mark `oldId` as superseded by `newId`. Both must already exist in the
 * memory table. Throws if either is missing.
 */
export async function supersedeMemoryV3(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) throw new Error('supersedeMemoryV3: old and new id are the same');
  const tx = getDb().transaction(() => {
    const oldRow = getDb().prepare('SELECT id FROM memory WHERE id = ?').get(oldId);
    const newRow = getDb().prepare('SELECT id FROM memory WHERE id = ?').get(newId);
    if (!oldRow) throw new Error(`supersedeMemoryV3: memory ${oldId} not found`);
    if (!newRow) throw new Error(`supersedeMemoryV3: memory ${newId} not found`);
    getDb().prepare(
      "UPDATE memory SET status = 'superseded', superseded_by = ? WHERE id = ?",
    ).run(newId, oldId);
  });
  tx();
}

export async function archiveMemoryV3(id: string): Promise<void> {
  getDb().prepare(
    "UPDATE memory SET status = 'archived' WHERE id = ?",
  ).run(id);
}

export interface UpdateMemoryV3Input {
  text?: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
}

/**
 * In-place edit for the v3 memory row. Used by the Debug panel's edit flow;
 * agent-driven evolution should prefer supersede to preserve the chain.
 * Returns null if `id` does not exist.
 */
export async function updateMemoryV3(
  id: string,
  patch: UpdateMemoryV3Input,
): Promise<MemoryRowV3 | null> {
  const existing = getDb().prepare('SELECT source FROM memory WHERE id = ?').get(id) as
    | { source?: string }
    | undefined;
  if (!existing) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.text !== undefined) { sets.push('text = ?'); vals.push(patch.text); }
  if (patch.subject !== undefined) { sets.push('subject = ?'); vals.push(patch.subject); }
  if (patch.quality !== undefined) {
    sets.push('quality = ?');
    vals.push(clampQuality(existing.source ?? '', patch.quality));
  }
  if (patch.confidence !== undefined) {
    sets.push('confidence = ?');
    vals.push(Math.max(0, Math.min(1, patch.confidence)));
  }
  if (patch.tags !== undefined) { sets.push('tags_json = ?'); vals.push(JSON.stringify(patch.tags)); }
  if (sets.length > 0) {
    vals.push(id);
    getDb().prepare(`UPDATE memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getMemoryV3(id);
}

const REFERENCED_BY_RUNS_CAP = 10;

/**
 * Append `runId` to a memory row's referenced_by_runs (cap 10), bump
 * reference_count, set last_referenced_at = now(). No-op if memory is
 * missing. See docs/plans/memory-architecture.mdx §五 (reference 三件套 cap).
 */
export async function markMemoryReferenced(
  memoryIds: string[],
  runId: string,
): Promise<number> {
  if (!runId || memoryIds.length === 0) return 0;
  let updated = 0;
  const ts = now();
  const tx = getDb().transaction(() => {
    for (const id of memoryIds) {
      const row = getDb().prepare(
        'SELECT referenced_by_runs FROM memory WHERE id = ?',
      ).get(id) as { referenced_by_runs?: string } | undefined;
      if (!row) continue;
      const existing = parseJsonArray<string>(row.referenced_by_runs);
      const nextRuns = existing.includes(runId)
        ? existing
        : [...existing.slice(-(REFERENCED_BY_RUNS_CAP - 1)), runId];
      getDb().prepare(
        `UPDATE memory
         SET reference_count = reference_count + 1,
             last_referenced_at = ?,
             referenced_by_runs = ?
         WHERE id = ?`,
      ).run(ts, JSON.stringify(nextRuns), id);
      updated += 1;
    }
  });
  tx();
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// v3 Skill index — metadata only; body lives in folder
//
//   ${OPENCLAW_HOME}/data/skills/<skill_id>/SKILL.md
//
// See docs/plans/memory-architecture.mdx §三 (skill_index).
// ─────────────────────────────────────────────────────────────────────────

export type SkillStatus = 'enabled' | 'disabled' | 'archived';

export interface SkillIndexRow {
  id: string;
  title: string;
  description: string | null;
  status: SkillStatus;
  revision: number;
  body_hash: string;
  triggers: string[];
  source: string;
  created_run_id: string | null;
  last_updated_run_id: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToSkillIndex(row: any): SkillIndexRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status: row.status as SkillStatus,
    revision: typeof row.revision === 'number' ? row.revision : 1,
    body_hash: row.body_hash ?? '',
    triggers: parseJsonArray<string>(row.triggers_json),
    source: row.source,
    created_run_id: row.created_run_id ?? null,
    last_updated_run_id: row.last_updated_run_id ?? null,
    enabled_at: row.enabled_at ?? null,
    disabled_at: row.disabled_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function getSkillsDir(): string {
  const home = process.env.OPENCLAW_HOME || '/app';
  return path.join(home, 'data', 'skills');
}

export function getSkillFolder(skillId: string): string {
  return path.join(getSkillsDir(), skillId);
}

export function getSkillBodyPath(skillId: string): string {
  return path.join(getSkillFolder(skillId), 'SKILL.md');
}

export function readSkillBody(skillId: string): string | null {
  try {
    return fs.readFileSync(getSkillBodyPath(skillId), 'utf8');
  } catch {
    return null;
  }
}

function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function writeSkillBodyFile(skillId: string, body: string): string {
  const folder = getSkillFolder(skillId);
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, 'SKILL.md');
  fs.writeFileSync(filePath, body);
  return hashBody(body);
}

export interface AddSkillInput {
  id: string;
  title: string;
  body: string;
  description?: string | null;
  triggers?: string[];
  source: string;
  createdRunId?: string | null;
  status?: SkillStatus;
}

export async function addSkill(input: AddSkillInput): Promise<SkillIndexRow> {
  if (!input.id || !input.id.trim()) throw new Error('addSkill: id is required');
  if (!input.title || !input.title.trim()) throw new Error('addSkill: title is required');
  if (!input.source || !input.source.trim()) throw new Error('addSkill: source is required');
  const id = input.id.trim();
  const status = input.status ?? 'enabled';
  const ts = now();
  const bodyHash = writeSkillBodyFile(id, input.body ?? '');
  const triggersJson = JSON.stringify(input.triggers ?? []);
  getDb().prepare(
    `INSERT INTO skill_index (
       id, title, description, status, revision, body_hash, triggers_json,
       source, created_run_id, last_updated_run_id,
       enabled_at, disabled_at, created_at, updated_at,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, 0, NULL, '[]')`,
  ).run(
    id, input.title.trim(), input.description ?? null, status,
    bodyHash, triggersJson, input.source, input.createdRunId ?? null,
    status === 'enabled' ? ts : null, ts, ts,
  );
  const row = getDb().prepare('SELECT * FROM skill_index WHERE id = ?').get(id);
  return rowToSkillIndex(row);
}

export interface UpdateSkillInput {
  id: string;
  title?: string;
  description?: string | null;
  body?: string;
  triggers?: string[];
  lastUpdatedRunId?: string | null;
}

/**
 * Update an existing skill. revision++ when the body actually changes
 * (body_hash differs). Throws if skill not found.
 */
export async function updateSkill(input: UpdateSkillInput): Promise<SkillIndexRow> {
  const id = input.id;
  const existing = getDb().prepare('SELECT * FROM skill_index WHERE id = ?').get(id) as any;
  if (!existing) throw new Error(`updateSkill: skill ${id} not found`);
  const ts = now();
  let revision = existing.revision as number;
  let bodyHash = existing.body_hash as string;
  if (typeof input.body === 'string') {
    const newHash = hashBody(input.body);
    if (newHash !== bodyHash) {
      writeSkillBodyFile(id, input.body);
      bodyHash = newHash;
      revision = revision + 1;
    }
  }
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [ts];
  if (typeof input.title === 'string' && input.title.trim()) {
    sets.push('title = ?'); vals.push(input.title.trim());
  }
  if (input.description !== undefined) {
    sets.push('description = ?'); vals.push(input.description ?? null);
  }
  if (Array.isArray(input.triggers)) {
    sets.push('triggers_json = ?'); vals.push(JSON.stringify(input.triggers));
  }
  if (input.lastUpdatedRunId !== undefined) {
    sets.push('last_updated_run_id = ?'); vals.push(input.lastUpdatedRunId ?? null);
  }
  sets.push('revision = ?'); vals.push(revision);
  sets.push('body_hash = ?'); vals.push(bodyHash);
  vals.push(id);
  getDb().prepare(`UPDATE skill_index SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const row = getDb().prepare('SELECT * FROM skill_index WHERE id = ?').get(id);
  return rowToSkillIndex(row);
}

export async function disableSkill(id: string): Promise<SkillIndexRow> {
  const ts = now();
  getDb().prepare(
    `UPDATE skill_index SET status = 'disabled', disabled_at = ?, updated_at = ? WHERE id = ?`,
  ).run(ts, ts, id);
  const row = getDb().prepare('SELECT * FROM skill_index WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`disableSkill: skill ${id} not found`);
  return rowToSkillIndex(row);
}

export async function enableSkill(id: string): Promise<SkillIndexRow> {
  const ts = now();
  getDb().prepare(
    `UPDATE skill_index SET status = 'enabled', enabled_at = ?, disabled_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(ts, ts, id);
  const row = getDb().prepare('SELECT * FROM skill_index WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`enableSkill: skill ${id} not found`);
  return rowToSkillIndex(row);
}

/**
 * Soft-delete a skill: flip status to 'archived'. Index row + body file
 * are kept so the change is reversible; `listSkills({status:'enabled'})`
 * will no longer surface it. Returns null when the skill does not exist.
 */
export async function archiveSkill(id: string): Promise<SkillIndexRow | null> {
  const ts = now();
  const info = getDb().prepare(
    `UPDATE skill_index SET status = 'archived', updated_at = ? WHERE id = ?`,
  ).run(ts, id);
  if (info.changes === 0) return null;
  return getSkillIndex(id);
}

export interface ListSkillsOpts {
  status?: SkillStatus;
  source?: string;
  limit?: number;
}

export async function listSkills(opts: ListSkillsOpts = {}): Promise<SkillIndexRow[]> {
  const parts = ['SELECT * FROM skill_index WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.status) { parts.push('AND status = ?'); params.push(opts.status); }
  if (opts.source) { parts.push('AND source = ?'); params.push(opts.source); }
  parts.push('ORDER BY updated_at DESC');
  parts.push('LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 100, 500)));
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToSkillIndex);
}

export async function getSkillIndex(id: string): Promise<SkillIndexRow | null> {
  const row = getDb().prepare('SELECT * FROM skill_index WHERE id = ?').get(id) as any;
  return row ? rowToSkillIndex(row) : null;
}

export async function markSkillReferenced(
  skillIds: string[],
  runId: string,
): Promise<number> {
  if (!runId || skillIds.length === 0) return 0;
  let updated = 0;
  const ts = now();
  const tx = getDb().transaction(() => {
    for (const id of skillIds) {
      const row = getDb().prepare(
        'SELECT referenced_by_runs FROM skill_index WHERE id = ?',
      ).get(id) as { referenced_by_runs?: string } | undefined;
      if (!row) continue;
      const existing = parseJsonArray<string>(row.referenced_by_runs);
      const nextRuns = existing.includes(runId)
        ? existing
        : [...existing.slice(-(REFERENCED_BY_RUNS_CAP - 1)), runId];
      getDb().prepare(
        `UPDATE skill_index
         SET reference_count = reference_count + 1,
             last_referenced_at = ?,
             referenced_by_runs = ?
         WHERE id = ?`,
      ).run(ts, JSON.stringify(nextRuns), id);
      updated += 1;
    }
  });
  tx();
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// v3 Evolution Runs — unified ledger (dream + crystallize + manual + consolidation).
// See docs/plans/memory-architecture.mdx §三 (evolution_runs).
// ─────────────────────────────────────────────────────────────────────────

export type EvolutionTrigger =
  | 'chat_burst'
  | 'daily_dream'
  | 'manual'
  | 'on_event'
  | 'consolidation';

export type EvolutionRunStatus = 'running' | 'completed' | 'failed';

export interface EvolutionRunRow {
  id: string;
  trigger_kind: EvolutionTrigger;
  status: EvolutionRunStatus;
  context_summary: string | null;
  window_start: string | null;
  window_end: string | null;
  memories_written: number;
  memories_archived: number;
  memories_superseded: number;
  profile_updated: boolean;
  profile_changed_keys: string[];
  skills_added: number;
  skills_updated: number;
  skills_disabled: number;
  signals_consumed: number;
  refs_consumed: Record<string, string[]>;
  refs_produced: Record<string, string[]>;
  prompt_excerpt: string | null;
  llm_tokens: number | null;
  duration_ms: number | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

function rowToEvolutionRun(row: any): EvolutionRunRow {
  return {
    id: row.id,
    trigger_kind: row.trigger_kind as EvolutionTrigger,
    status: row.status as EvolutionRunStatus,
    context_summary: row.context_summary ?? null,
    window_start: row.window_start ?? null,
    window_end: row.window_end ?? null,
    memories_written: row.memories_written ?? 0,
    memories_archived: row.memories_archived ?? 0,
    memories_superseded: row.memories_superseded ?? 0,
    profile_updated: (row.profile_updated ?? 0) === 1 || row.profile_updated === true,
    profile_changed_keys: parseJsonArray<string>(row.profile_changed_keys_json),
    skills_added: row.skills_added ?? 0,
    skills_updated: row.skills_updated ?? 0,
    skills_disabled: row.skills_disabled ?? 0,
    signals_consumed: row.signals_consumed ?? 0,
    refs_consumed: parseJson<Record<string, string[]>>(row.refs_consumed_json) ?? {},
    refs_produced: parseJson<Record<string, string[]>>(row.refs_produced_json) ?? {},
    prompt_excerpt: row.prompt_excerpt ?? null,
    llm_tokens: row.llm_tokens ?? null,
    duration_ms: row.duration_ms ?? null,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
    error_message: row.error_message ?? null,
  };
}

export interface CreateEvolutionRunInput {
  triggerKind: EvolutionTrigger;
  windowStart?: string | null;
  windowEnd?: string | null;
  contextSummary?: string | null;
  promptExcerpt?: string | null;
  /** Optional explicit id; if omitted a UUID is generated. */
  id?: string;
}

export async function createEvolutionRun(
  input: CreateEvolutionRunInput,
): Promise<EvolutionRunRow> {
  const id = input.id ?? genId();
  const ts = now();
  getDb().prepare(
    `INSERT INTO evolution_runs (
       id, trigger_kind, status,
       context_summary, window_start, window_end,
       prompt_excerpt, started_at
     ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.triggerKind,
    input.contextSummary ?? null,
    input.windowStart ?? null,
    input.windowEnd ?? null,
    input.promptExcerpt ?? null,
    ts,
  );
  return (await getEvolutionRun(id))!;
}

export async function getEvolutionRun(id: string): Promise<EvolutionRunRow | null> {
  const row = getDb().prepare('SELECT * FROM evolution_runs WHERE id = ?').get(id) as any;
  return row ? rowToEvolutionRun(row) : null;
}

export interface RecordEvolutionDelta {
  memoriesWritten?: number;
  memoriesArchived?: number;
  memoriesSuperseded?: number;
  profileUpdated?: boolean;
  profileChangedKeys?: string[];
  skillsAdded?: number;
  skillsUpdated?: number;
  skillsDisabled?: number;
  signalsConsumed?: number;
}

/**
 * Bump the per-run counter columns by the deltas provided. JSON fields
 * (profileChangedKeys) replace rather than merge — caller passes the full
 * cumulative set when calling.
 */
export async function recordEvolutionDelta(
  runId: string,
  delta: RecordEvolutionDelta,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const bump = (col: string, value: number | undefined) => {
    if (typeof value === 'number' && value !== 0) {
      sets.push(`${col} = ${col} + ?`);
      vals.push(value);
    }
  };
  bump('memories_written', delta.memoriesWritten);
  bump('memories_archived', delta.memoriesArchived);
  bump('memories_superseded', delta.memoriesSuperseded);
  bump('skills_added', delta.skillsAdded);
  bump('skills_updated', delta.skillsUpdated);
  bump('skills_disabled', delta.skillsDisabled);
  bump('signals_consumed', delta.signalsConsumed);
  if (typeof delta.profileUpdated === 'boolean') {
    sets.push('profile_updated = ?');
    vals.push(delta.profileUpdated ? 1 : 0);
  }
  if (Array.isArray(delta.profileChangedKeys)) {
    sets.push('profile_changed_keys_json = ?');
    vals.push(JSON.stringify(delta.profileChangedKeys));
  }
  if (sets.length === 0) return;
  vals.push(runId);
  getDb().prepare(`UPDATE evolution_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * Append `ids` to refs_consumed[table] for the given run. Dedupes within
 * the table key. No-op if ids is empty. The DB row stores the full merged
 * JSON object after each call.
 */
export async function recordEvolutionRefsConsumed(
  runId: string,
  table: string,
  ids: string[],
): Promise<void> {
  if (!table || ids.length === 0) return;
  const tx = getDb().transaction(() => {
    const row = getDb().prepare(
      'SELECT refs_consumed_json FROM evolution_runs WHERE id = ?',
    ).get(runId) as { refs_consumed_json?: string } | undefined;
    if (!row) return;
    const obj = parseJson<Record<string, string[]>>(row.refs_consumed_json) ?? {};
    const existing = Array.isArray(obj[table]) ? obj[table] : [];
    const seen = new Set(existing);
    for (const id of ids) seen.add(id);
    obj[table] = Array.from(seen);
    getDb().prepare(
      'UPDATE evolution_runs SET refs_consumed_json = ? WHERE id = ?',
    ).run(JSON.stringify(obj), runId);
  });
  tx();
}

export async function recordEvolutionRefsProduced(
  runId: string,
  table: string,
  ids: string[],
): Promise<void> {
  if (!table || ids.length === 0) return;
  const tx = getDb().transaction(() => {
    const row = getDb().prepare(
      'SELECT refs_produced_json FROM evolution_runs WHERE id = ?',
    ).get(runId) as { refs_produced_json?: string } | undefined;
    if (!row) return;
    const obj = parseJson<Record<string, string[]>>(row.refs_produced_json) ?? {};
    const existing = Array.isArray(obj[table]) ? obj[table] : [];
    const seen = new Set(existing);
    for (const id of ids) seen.add(id);
    obj[table] = Array.from(seen);
    getDb().prepare(
      'UPDATE evolution_runs SET refs_produced_json = ? WHERE id = ?',
    ).run(JSON.stringify(obj), runId);
  });
  tx();
}

export async function completeEvolutionRun(
  runId: string,
  opts: { llmTokens?: number; durationMs?: number } = {},
): Promise<EvolutionRunRow> {
  const ts = now();
  const sets = ['status = ?', 'completed_at = ?'];
  const vals: unknown[] = ['completed', ts];
  if (typeof opts.llmTokens === 'number') {
    sets.push('llm_tokens = ?'); vals.push(opts.llmTokens);
  }
  if (typeof opts.durationMs === 'number') {
    sets.push('duration_ms = ?'); vals.push(opts.durationMs);
  }
  vals.push(runId);
  getDb().prepare(`UPDATE evolution_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const row = await getEvolutionRun(runId);
  if (!row) throw new Error(`completeEvolutionRun: run ${runId} not found`);
  return row;
}

export async function failEvolutionRun(runId: string, errorMessage: string): Promise<EvolutionRunRow> {
  const ts = now();
  getDb().prepare(
    `UPDATE evolution_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`,
  ).run(ts, errorMessage, runId);
  const row = await getEvolutionRun(runId);
  if (!row) throw new Error(`failEvolutionRun: run ${runId} not found`);
  return row;
}

export interface ListEvolutionRunsOpts {
  triggerKind?: EvolutionTrigger;
  status?: EvolutionRunStatus;
  since?: string;
  limit?: number;
}

export async function listEvolutionRuns(
  opts: ListEvolutionRunsOpts = {},
): Promise<EvolutionRunRow[]> {
  const parts = ['SELECT * FROM evolution_runs WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.triggerKind) { parts.push('AND trigger_kind = ?'); params.push(opts.triggerKind); }
  if (opts.status) { parts.push('AND status = ?'); params.push(opts.status); }
  if (opts.since) { parts.push('AND started_at >= ?'); params.push(opts.since); }
  parts.push('ORDER BY started_at DESC');
  parts.push('LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 200)));
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToEvolutionRun);
}

// ─────────────────────────────────────────────────────────────────────────
// v3 Personal Signals — short-lived observations awaiting consolidation.
// See docs/plans/memory-architecture.mdx §三 (personal_signals).
// ─────────────────────────────────────────────────────────────────────────

export type PersonalSignalStatus = 'open' | 'consumed' | 'archived';

export interface PersonalSignalRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  salience: number;
  confidence: number;
  dedupe_key: string | null;
  occurred_at: string;
  available_at: string;
  expires_at: string | null;
  source: string;
  device_id: string | null;
  subject: string | null;
  source_raw_table: string | null;
  source_raw_ids: string[];
  status: PersonalSignalStatus;
  consumed_by_run_id: string | null;
  ingested_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

const DEFAULT_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function rowToPersonalSignal(row: any): PersonalSignalRow {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    payload: parseJson<Record<string, unknown>>(row.payload_json) ?? {},
    salience: typeof row.salience === 'number' ? row.salience : 0,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0,
    dedupe_key: row.dedupe_key ?? null,
    occurred_at: row.occurred_at,
    available_at: row.available_at,
    expires_at: row.expires_at ?? null,
    source: row.source,
    device_id: row.device_id ?? null,
    subject: row.subject ?? null,
    source_raw_table: row.source_raw_table ?? null,
    source_raw_ids: parseJsonArray<string>(row.source_raw_ids_json),
    status: row.status as PersonalSignalStatus,
    consumed_by_run_id: row.consumed_by_run_id ?? null,
    ingested_at: row.ingested_at,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export interface IngestPersonalSignalInput {
  id?: string;
  kind: string;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  salience?: number;
  confidence?: number;
  dedupeKey?: string | null;
  occurredAt?: string;
  availableAt?: string;
  expiresAt?: string | null;
  source?: string;
  deviceId?: string | null;
  subject?: string | null;
  sourceRawTable?: string | null;
  sourceRawIds?: string[];
  status?: PersonalSignalStatus;
}

export interface IngestPersonalSignalsResult {
  accepted: number;
  inserted: number;
  ignored: number;
  ids: string[];
}

/**
 * Idempotent batch insert. Items with a dedupe_key that already exists are
 * silently ignored (INSERT OR IGNORE). Returns the freshly-inserted ids
 * (in insertion order) so callers can immediately mark them referenced.
 */
export async function ingestPersonalSignals(
  inputs: IngestPersonalSignalInput[],
): Promise<IngestPersonalSignalsResult> {
  if (inputs.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const ts = now();
  const ids: string[] = [];
  let inserted = 0;
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO personal_signals (
       id, kind, title, summary, payload_json, salience, confidence,
       dedupe_key, occurred_at, available_at, expires_at,
       source, device_id, subject, source_raw_table, source_raw_ids_json,
       status, ingested_at,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = getDb().transaction((items: IngestPersonalSignalInput[]) => {
    for (const item of items) {
      if (!item.kind || !item.title || !item.summary) continue;
      const id = item.id ?? genId();
      const occurredAt = item.occurredAt ?? ts;
      const availableAt = item.availableAt ?? occurredAt;
      const defaultExpires = new Date(Date.parse(occurredAt) + DEFAULT_SIGNAL_TTL_MS).toISOString();
      const expiresAt = item.expiresAt === null ? null : (item.expiresAt ?? defaultExpires);
      const result = insert.run(
        id,
        item.kind,
        item.title,
        item.summary,
        JSON.stringify(item.payload ?? {}),
        typeof item.salience === 'number' ? item.salience : 0,
        typeof item.confidence === 'number' ? item.confidence : 0,
        item.dedupeKey?.trim() || null,
        occurredAt,
        availableAt,
        expiresAt,
        item.source ?? 'device',
        item.deviceId ?? null,
        item.subject ?? null,
        item.sourceRawTable ?? null,
        JSON.stringify(item.sourceRawIds ?? []),
        item.status ?? 'open',
        ts,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx(inputs);
  return {
    accepted: inputs.filter((i) => i.kind && i.title && i.summary).length,
    inserted,
    ignored: inputs.length - inserted,
    ids,
  };
}

export interface ListPersonalSignalsOpts {
  status?: PersonalSignalStatus;
  kind?: string;
  source?: string;
  deviceId?: string;
  since?: string;
  until?: string;
  minSalience?: number;
  limit?: number;
  /** When true, also expire any rows whose expires_at has passed before listing. */
  pruneExpired?: boolean;
}

export async function listPersonalSignals(
  opts: ListPersonalSignalsOpts = {},
): Promise<PersonalSignalRow[]> {
  if (opts.pruneExpired) await expireElapsedPersonalSignals();
  const parts = ['SELECT * FROM personal_signals WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.status) { parts.push('AND status = ?'); params.push(opts.status); }
  if (opts.kind) { parts.push('AND kind = ?'); params.push(opts.kind); }
  if (opts.source) { parts.push('AND source = ?'); params.push(opts.source); }
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (opts.since) { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until) { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  if (typeof opts.minSalience === 'number') { parts.push('AND salience >= ?'); params.push(opts.minSalience); }
  parts.push('ORDER BY occurred_at DESC');
  parts.push('LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToPersonalSignal);
}

export async function getPersonalSignal(id: string): Promise<PersonalSignalRow | null> {
  const row = getDb().prepare('SELECT * FROM personal_signals WHERE id = ?').get(id) as any;
  return row ? rowToPersonalSignal(row) : null;
}

/**
 * Mark `signalIds` as consumed by `runId`. Rows already consumed/archived
 * are skipped. Returns the count actually transitioned.
 */
export async function markPersonalSignalsConsumed(
  signalIds: string[],
  runId: string,
): Promise<number> {
  if (!runId || signalIds.length === 0) return 0;
  const ts = now();
  let updated = 0;
  const tx = getDb().transaction(() => {
    for (const id of signalIds) {
      const result = getDb().prepare(
        `UPDATE personal_signals
         SET status = 'consumed', consumed_by_run_id = ?, last_referenced_at = ?
         WHERE id = ? AND status = 'open'`,
      ).run(runId, ts, id);
      if (result.changes > 0) updated += 1;
    }
  });
  tx();
  return updated;
}

/** Move open signals past their expires_at to status='archived'. Returns count. */
export async function expireElapsedPersonalSignals(cutoff = now()): Promise<number> {
  const result = getDb().prepare(
    `UPDATE personal_signals
     SET status = 'archived'
     WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`,
  ).run(cutoff);
  return result.changes;
}

export async function markPersonalSignalsReferenced(
  signalIds: string[],
  runId: string,
): Promise<number> {
  if (!runId || signalIds.length === 0) return 0;
  let updated = 0;
  const ts = now();
  const tx = getDb().transaction(() => {
    for (const id of signalIds) {
      const row = getDb().prepare(
        'SELECT referenced_by_runs FROM personal_signals WHERE id = ?',
      ).get(id) as { referenced_by_runs?: string } | undefined;
      if (!row) continue;
      const existing = parseJsonArray<string>(row.referenced_by_runs);
      const nextRuns = existing.includes(runId)
        ? existing
        : [...existing.slice(-(REFERENCED_BY_RUNS_CAP - 1)), runId];
      getDb().prepare(
        `UPDATE personal_signals
         SET reference_count = reference_count + 1,
             last_referenced_at = ?,
             referenced_by_runs = ?
         WHERE id = ?`,
      ).run(ts, JSON.stringify(nextRuns), id);
      updated += 1;
    }
  });
  tx();
  return updated;
}
