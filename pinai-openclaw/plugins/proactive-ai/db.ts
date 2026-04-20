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

    CREATE TABLE IF NOT EXISTS profile_memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS push_records (
      id TEXT PRIMARY KEY,
      intent_card_id TEXT,
      kind TEXT NOT NULL,
      basket TEXT,
      title TEXT NOT NULL,
      ref TEXT,
      reason TEXT,
      pushed_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_pushed ON push_records(pushed_at DESC);

    CREATE TABLE IF NOT EXISTS push_outcomes (
      id TEXT PRIMARY KEY,
      push_id TEXT NOT NULL REFERENCES push_records(id),
      status TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_items (
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
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_world_published ON world_items(published_at DESC);

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

    CREATE TABLE IF NOT EXISTS auto_loop_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT,
      updated_at TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS ingest_cursor (
      source TEXT PRIMARY KEY,
      cursor TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_items (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processed')),
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_status_available ON pending_items(status, available_at);

    CREATE TABLE IF NOT EXISTS context_runs (
      run_token TEXT PRIMARY KEY,
      item_ids_json TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'expired')),
      committed_at TEXT
    );

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

    CREATE TABLE IF NOT EXISTS chat_crystallize_state (
      id TEXT PRIMARY KEY DEFAULT 'default',
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_crystallized_at TEXT,
      last_session_key TEXT,
      last_message_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_skills (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      triggers_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_skills_status ON user_skills(status);
    CREATE INDEX IF NOT EXISTS idx_user_skills_updated ON user_skills(updated_at DESC);
  `);

  ensureColumn(db, 'feedback_events', 'conversation_id', 'TEXT');
  ensureColumn(db, 'feedback_events', 'message_id', 'TEXT');
  ensureColumn(db, 'feedback_events', 'channel', 'TEXT');
  ensureColumn(db, 'feedback_events', 'intent_key', 'TEXT');
  ensureColumn(db, 'user_settings', 'auto_crystallize', 'INTEGER NOT NULL DEFAULT 1');
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

export interface MemoryRow {
  id: string;
  user_id: string;
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

function rowToMemory(row: any): MemoryRow {
  return {
    id: row.id,
    user_id: USER_ID,
    kind: row.kind,
    text: row.text,
    tags: parseJsonArray<string>(row.tags),
    created_at: row.created_at,
  };
}

export async function listMemories(opts?: { limit?: number }): Promise<MemoryRow[]> {
  const limit = opts?.limit ?? 1000;
  const rows = getDb().prepare('SELECT * FROM profile_memories ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
  return rows.map(rowToMemory);
}

export async function addMemory(input: {
  kind: string;
  text: string;
  tags?: string[];
}): Promise<MemoryRow> {
  const id = genId();
  const ts = now();
  getDb().prepare('INSERT INTO profile_memories (id, kind, text, tags, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, input.kind, input.text, JSON.stringify(input.tags ?? []), ts);
  return { id, user_id: USER_ID, kind: input.kind, text: input.text, tags: input.tags ?? [], created_at: ts };
}

export async function searchMemory(query: string, opts?: { limit?: number }): Promise<MemoryRow[]> {
  const limit = opts?.limit ?? 20;
  const rows = getDb().prepare('SELECT * FROM profile_memories WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?')
    .all(`%${query}%`, limit) as any[];
  return rows.map(rowToMemory);
}

export async function removeMemory(id: string): Promise<void> {
  getDb().prepare('DELETE FROM profile_memories WHERE id = ?').run(id);
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

// ── Push Records ──

export interface PushRecordRow {
  id: string;
  user_id: string;
  intent_card_id: string | null;
  kind: string;
  basket: string | null;
  title: string;
  ref: string | null;
  reason: string | null;
  pushed_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PushOutcomeRow {
  id: string;
  push_id: string;
  status: string;
  metadata: Record<string, unknown>;
  recorded_at: string;
}

function rowToPush(row: any): PushRecordRow {
  return { ...row, user_id: USER_ID, metadata: parseJson(row.metadata) };
}

function rowToOutcome(row: any): PushOutcomeRow {
  return { ...row, metadata: parseJson(row.metadata) };
}

export async function recordPush(input: {
  kind: string;
  title: string;
  intentCardId?: string;
  basket?: string;
  channel?: string;
  ref?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}): Promise<PushRecordRow> {
  const id = genId();
  const ts = now();
  const meta = { ...(input.metadata ?? {}), ...(input.channel ? { channel: input.channel } : {}) };
  getDb().prepare(
    'INSERT INTO push_records (id, intent_card_id, kind, basket, title, ref, reason, pushed_at, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.intentCardId ?? null, input.kind, input.basket ?? null, input.title,
    input.ref ?? null, input.reason ?? null, ts, JSON.stringify(meta), ts);
  return {
    id, user_id: USER_ID, intent_card_id: input.intentCardId ?? null,
    kind: input.kind, basket: input.basket ?? null, title: input.title,
    ref: input.ref ?? null, reason: input.reason ?? null,
    pushed_at: ts, metadata: meta, created_at: ts,
  };
}

export async function pushHistory(opts?: {
  kind?: string;
  basket?: string;
  since?: string;
  limit?: number;
}): Promise<PushRecordRow[]> {
  const parts = ['SELECT * FROM push_records WHERE 1=1'];
  const params: unknown[] = [];
  if (opts?.kind) { parts.push('AND kind = ?'); params.push(opts.kind); }
  if (opts?.basket) { parts.push('AND basket = ?'); params.push(opts.basket); }
  if (opts?.since) { parts.push('AND pushed_at >= ?'); params.push(opts.since); }
  parts.push('ORDER BY pushed_at DESC');
  if (opts?.limit) { parts.push('LIMIT ?'); params.push(opts.limit); }
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToPush);
}

export async function getPush(id: string): Promise<{ record: PushRecordRow; outcomes: PushOutcomeRow[] } | null> {
  const row = getDb().prepare('SELECT * FROM push_records WHERE id = ?').get(id) as any;
  if (!row) return null;
  const outcomes = getDb().prepare('SELECT * FROM push_outcomes WHERE push_id = ? ORDER BY recorded_at DESC').all(id) as any[];
  return { record: rowToPush(row), outcomes: outcomes.map(rowToOutcome) };
}

export async function recordOutcome(pushId: string, status: string, metadata?: Record<string, unknown>): Promise<PushOutcomeRow> {
  const id = genId();
  const ts = now();
  const meta = JSON.stringify(metadata ?? {});
  getDb().prepare('INSERT INTO push_outcomes (id, push_id, status, metadata, recorded_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, pushId, status, meta, ts);
  return { id, push_id: pushId, status, metadata: metadata ?? {}, recorded_at: ts };
}

export async function findSimilarPushes(opts: {
  kind: string;
  ref?: string;
  title?: string;
  since?: string;
}): Promise<PushRecordRow[]> {
  const parts = ['SELECT * FROM push_records WHERE kind = ?'];
  const params: unknown[] = [opts.kind];
  if (opts.since) { parts.push('AND pushed_at >= ?'); params.push(opts.since); }
  if (opts.ref) { parts.push('AND ref = ?'); params.push(opts.ref); }
  if (opts.title) { parts.push('AND title LIKE ?'); params.push(`%${opts.title}%`); }
  parts.push('ORDER BY pushed_at DESC LIMIT 20');
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToPush);
}

// ── World Items ──

export interface WorldItemRow {
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
}

function rowToWorldItem(row: any): WorldItemRow {
  return {
    ...row,
    search_queries: parseJsonArray<string>(row.search_queries),
    topics: parseJsonArray<string>(row.topics),
    regions: parseJsonArray<string>(row.regions),
    metadata: parseJson(row.metadata),
  };
}

export async function ingestWorldItem(input: {
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
}): Promise<WorldItemRow> {
  const db = getDb();
  const id = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO world_items (id, provider, stream_type, title, url, normalized_url, external_id, summary, published_at,
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
  const row = db.prepare('SELECT * FROM world_items WHERE normalized_url = ?').get(input.normalizedUrl) as any;
  return rowToWorldItem(row);
}

export async function listWorldItems(opts?: {
  query?: string;
  provider?: string;
  since?: string;
  limit?: number;
}): Promise<WorldItemRow[]> {
  const parts = ['SELECT * FROM world_items WHERE 1=1'];
  const params: unknown[] = [];
  if (opts?.query) { parts.push('AND title LIKE ?'); params.push(`%${opts.query}%`); }
  if (opts?.provider) { parts.push('AND provider = ?'); params.push(opts.provider); }
  if (opts?.since) { parts.push('AND published_at >= ?'); params.push(opts.since); }
  parts.push('ORDER BY COALESCE(published_at, created_at) DESC');
  if (opts?.limit) { parts.push('LIMIT ?'); params.push(opts.limit); }
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(rowToWorldItem);
}

export async function getWorldItem(id: string): Promise<WorldItemRow | null> {
  const row = getDb().prepare('SELECT * FROM world_items WHERE id = ?').get(id) as any;
  return row ? rowToWorldItem(row) : null;
}

export async function listWorldItemsByIds(ids: string[]): Promise<WorldItemRow[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM world_items WHERE id IN (${placeholders})`).all(...ids) as any[];
  const mapped = rows.map(rowToWorldItem);
  // Preserve input order
  const order = new Map(ids.map((id, i) => [id, i]));
  return mapped.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface WorldSemanticCandidate extends WorldItemRow {
  searchText: string;
}

export async function listSemanticIndexCandidates(opts?: { limit?: number }): Promise<WorldSemanticCandidate[]> {
  const items = await listWorldItems({ limit: opts?.limit ?? 100 });
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
  };
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
  getDb().prepare(
    'INSERT INTO pipeline_runs (id, run_id, status, total_iterations, final_cards, iterations, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.runId, input.status, input.totalIterations,
    JSON.stringify(input.finalCards), JSON.stringify(input.iterations), ts, ts);
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

// ── Chat Crystallize State ──

export interface ChatCrystallizeStateRow {
  turn_count: number;
  last_crystallized_at: string | null;
  last_session_key: string | null;
  last_message_at: string | null;
  updated_at: string;
}

function ensureCrystallizeStateRow(db: Database.Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO chat_crystallize_state (id, turn_count, updated_at) VALUES ('default', 0, ?)",
  ).run(now());
}

export async function getCrystallizeState(): Promise<ChatCrystallizeStateRow> {
  const db = getDb();
  ensureCrystallizeStateRow(db);
  const row = db.prepare("SELECT * FROM chat_crystallize_state WHERE id = 'default'").get() as any;
  return {
    turn_count: Number(row.turn_count ?? 0),
    last_crystallized_at: row.last_crystallized_at ?? null,
    last_session_key: row.last_session_key ?? null,
    last_message_at: row.last_message_at ?? null,
    updated_at: row.updated_at,
  };
}

export async function bumpCrystallizeTurn(sessionKey: string): Promise<ChatCrystallizeStateRow> {
  const db = getDb();
  const ts = now();
  ensureCrystallizeStateRow(db);
  db.prepare(`
    UPDATE chat_crystallize_state
    SET turn_count = turn_count + 1,
        last_session_key = ?,
        last_message_at = ?,
        updated_at = ?
    WHERE id = 'default'
  `).run(sessionKey, ts, ts);
  return getCrystallizeState();
}

export async function markCrystallized(): Promise<void> {
  const db = getDb();
  const ts = now();
  ensureCrystallizeStateRow(db);
  db.prepare(`
    UPDATE chat_crystallize_state
    SET turn_count = 0,
        last_crystallized_at = ?,
        updated_at = ?
    WHERE id = 'default'
  `).run(ts, ts);
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

function rowToUserSkill(row: any): UserSkillRow {
  const status = row.status === 'disabled' ? 'disabled' : 'active';
  return {
    id: row.id,
    title: row.title,
    body_md: row.body_md,
    triggers: parseJsonArray<string>(row.triggers_json),
    source: row.source,
    status,
    source_summary: row.source_summary ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUserSkills(opts?: {
  status?: 'active' | 'disabled';
  limit?: number;
}): Promise<UserSkillRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 200;
  const rows = opts?.status
    ? db.prepare('SELECT * FROM user_skills WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
        .all(opts.status, limit) as any[]
    : db.prepare('SELECT * FROM user_skills ORDER BY updated_at DESC LIMIT ?')
        .all(limit) as any[];
  return rows.map(rowToUserSkill);
}

export async function getUserSkill(id: string): Promise<UserSkillRow | null> {
  const row = getDb().prepare('SELECT * FROM user_skills WHERE id = ?').get(id) as any;
  return row ? rowToUserSkill(row) : null;
}

export async function addUserSkill(input: {
  title: string;
  body_md: string;
  triggers?: string[];
  source: string;
  status?: 'active' | 'disabled';
  source_summary?: string | null;
}): Promise<UserSkillRow> {
  const db = getDb();
  const id = genId();
  const ts = now();
  const status = input.status ?? 'active';
  db.prepare(`
    INSERT INTO user_skills
      (id, title, body_md, triggers_json, source, status, source_summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.title,
    input.body_md,
    JSON.stringify(input.triggers ?? []),
    input.source,
    status,
    input.source_summary ?? null,
    ts,
    ts,
  );
  return {
    id,
    title: input.title,
    body_md: input.body_md,
    triggers: input.triggers ?? [],
    source: input.source,
    status,
    source_summary: input.source_summary ?? null,
    created_at: ts,
    updated_at: ts,
  };
}

export async function updateUserSkill(
  id: string,
  patch: Partial<Pick<UserSkillRow, 'title' | 'body_md' | 'triggers' | 'status' | 'source_summary'>>,
): Promise<UserSkillRow | null> {
  const db = getDb();
  const existing = await getUserSkill(id);
  if (!existing) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
  if (patch.body_md !== undefined) { sets.push('body_md = ?'); vals.push(patch.body_md); }
  if (patch.triggers !== undefined) { sets.push('triggers_json = ?'); vals.push(JSON.stringify(patch.triggers)); }
  if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
  if (patch.source_summary !== undefined) { sets.push('source_summary = ?'); vals.push(patch.source_summary); }
  if (sets.length === 0) return existing;
  sets.push('updated_at = ?'); vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE user_skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getUserSkill(id);
}

export async function deleteUserSkill(id: string): Promise<boolean> {
  const info = getDb().prepare('DELETE FROM user_skills WHERE id = ?').run(id);
  return info.changes > 0;
}

// ── Auto-Loop State ──

export interface AutoLoopStateRow {
  user_id: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  updated_at: string;
}

export async function getAutoLoopState(): Promise<AutoLoopStateRow> {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO auto_loop_state (id, updated_at) VALUES (1, ?)").run(now());
  const row = db.prepare('SELECT * FROM auto_loop_state WHERE id = 1').get() as any;
  return {
    user_id: USER_ID,
    last_started_at: row.last_started_at,
    last_finished_at: row.last_finished_at,
    last_status: row.last_status,
    updated_at: row.updated_at,
  };
}

export async function saveAutoLoopState(fields: Partial<Pick<AutoLoopStateRow, 'last_started_at' | 'last_finished_at' | 'last_status'>>): Promise<void> {
  const db = getDb();
  const ts = now();
  db.prepare("INSERT OR IGNORE INTO auto_loop_state (id, updated_at) VALUES (1, ?)").run(ts);
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [ts];
  if (fields.last_started_at !== undefined) { sets.push('last_started_at = ?'); vals.push(fields.last_started_at); }
  if (fields.last_finished_at !== undefined) { sets.push('last_finished_at = ?'); vals.push(fields.last_finished_at); }
  if (fields.last_status !== undefined) { sets.push('last_status = ?'); vals.push(fields.last_status); }
  db.prepare(`UPDATE auto_loop_state SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
}

// ── Pending Store (ingest cursors, pending items, context runs) ──

export type PendingSource = 'world' | 'personal';
export type PendingStatus = 'pending' | 'processed';

export interface PendingItem {
  id: string;
  source: PendingSource;
  kind: string;
  createdAt: string;
  availableAt: string;
  status: PendingStatus;
  processedAt: string | null;
  payload: Record<string, unknown>;
}

export interface PendingStoreState {
  worldCursorUpdatedAt: string | null;
  personalSnapshotHash: string | null;
  items: PendingItem[];
}

export async function getIngestCursor(source: PendingSource): Promise<string | null> {
  const row = getDb().prepare('SELECT cursor FROM ingest_cursor WHERE source = ?').get(source) as any;
  return row?.cursor ?? null;
}

export async function setIngestCursor(source: PendingSource, cursor: string): Promise<void> {
  getDb().prepare(`
    INSERT INTO ingest_cursor (source, cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `).run(source, cursor, now());
}

export async function loadPendingStore(limit = 500): Promise<PendingStoreState> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM pending_items ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as any[];
  const items: PendingItem[] = rows.map(row => ({
    id: row.id,
    source: row.source as PendingSource,
    kind: row.kind,
    createdAt: row.created_at,
    availableAt: row.available_at,
    status: row.status as PendingStatus,
    processedAt: row.processed_at,
    payload: parseJson(row.payload_json),
  }));
  return {
    worldCursorUpdatedAt: (await getIngestCursor('world')),
    personalSnapshotHash: (await getIngestCursor('personal')),
    items,
  };
}

export async function addPendingItem(input: {
  id: string;
  source: PendingSource;
  kind: string;
  payload: Record<string, unknown>;
  availableAt?: string;
}): Promise<void> {
  const ts = now();
  getDb().prepare(
    'INSERT OR IGNORE INTO pending_items (id, source, kind, payload_json, created_at, available_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(input.id, input.source, input.kind, JSON.stringify(input.payload), ts, input.availableAt ?? ts, 'pending');
}

export async function markPendingProcessed(id: string): Promise<void> {
  getDb().prepare("UPDATE pending_items SET status = 'processed', processed_at = ? WHERE id = ?").run(now(), id);
}

export async function listPendingItems(opts?: { source?: PendingSource; status?: PendingStatus; limit?: number }): Promise<PendingItem[]> {
  const parts = ['SELECT * FROM pending_items WHERE 1=1'];
  const params: unknown[] = [];
  if (opts?.source) { parts.push('AND source = ?'); params.push(opts.source); }
  if (opts?.status) { parts.push('AND status = ?'); params.push(opts.status); }
  parts.push('ORDER BY available_at ASC');
  if (opts?.limit) { parts.push('LIMIT ?'); params.push(opts.limit); }
  const rows = getDb().prepare(parts.join(' ')).all(...params) as any[];
  return rows.map(row => ({
    id: row.id,
    source: row.source as PendingSource,
    kind: row.kind,
    createdAt: row.created_at,
    availableAt: row.available_at,
    status: row.status as PendingStatus,
    processedAt: row.processed_at,
    payload: parseJson(row.payload_json),
  }));
}

// ── Context Runs ──

export interface ContextRun {
  runToken: string;
  itemIds: string[];
  itemCount: number;
  createdAt: string;
  status: 'open' | 'committed' | 'expired';
  committedAt: string | null;
}

export async function createContextRun(runToken: string, itemIds: string[]): Promise<ContextRun> {
  const ts = now();
  getDb().prepare(
    "INSERT INTO context_runs (run_token, item_ids_json, item_count, created_at, status) VALUES (?, ?, ?, ?, 'open')"
  ).run(runToken, JSON.stringify(itemIds), itemIds.length, ts);
  return { runToken, itemIds, itemCount: itemIds.length, createdAt: ts, status: 'open', committedAt: null };
}

export async function commitContextRun(runToken: string): Promise<void> {
  getDb().prepare("UPDATE context_runs SET status = 'committed', committed_at = ? WHERE run_token = ?").run(now(), runToken);
}

export async function getContextRun(runToken: string): Promise<ContextRun | null> {
  const row = getDb().prepare('SELECT * FROM context_runs WHERE run_token = ?').get(runToken) as any;
  if (!row) return null;
  return {
    runToken: row.run_token,
    itemIds: parseJsonArray<string>(row.item_ids_json),
    itemCount: row.item_count,
    createdAt: row.created_at,
    status: row.status,
    committedAt: row.committed_at,
  };
}

export async function expireOldContextRuns(maxAgeMs = 3600_000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = getDb().prepare("UPDATE context_runs SET status = 'expired' WHERE status = 'open' AND created_at < ?").run(cutoff);
  return result.changes;
}
