/**
 * Tests for the Phase 13 legacy → v3 backfill (migrateLegacyToV3).
 *
 * Strategy: write to a tmp DB the v2 schema directly (CREATE the legacy
 * tables + INSERT rows), then call resetDbForTests + getProfile (which
 * triggers ensureSchema + migration). After migration, the legacy tables
 * must be dropped and the rows must appear in the v3 sinks.
 *
 * See docs/plans/memory-architecture.mdx §七.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  getProfile,
  getMemoryV3,
  getSkillBodyPath,
  getSkillIndex,
  listMemoryV3,
  listSkills,
  resetDbForTests,
} from './db.ts';

function withFreshHome(fn: (home: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'pin-legacy-mig-'));
    const previous = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    try {
      await fn(home);
    } finally {
      resetDbForTests();
      if (previous === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

/** Pre-create the v2 legacy tables + seed rows in a tmp DB before any
 * helper opens it. ensureSchema will then see them and migrate.  */
function seedLegacyDb(home: string, fixture: {
  memories?: Array<{ id: string; kind: string; text: string; tags?: string[]; createdAt: string }>;
  skills?: Array<{ id: string; title: string; body_md: string; triggers?: string[]; source: string; status?: string; source_summary?: string; createdAt: string; updatedAt: string }>;
}): void {
  const dbPath = join(home, 'data', `proactive.db`);
  mkdirSync(join(home, 'data'), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE profile_memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE user_skills (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body_md TEXT NOT NULL,
      triggers_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', source_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  for (const m of fixture.memories ?? []) {
    db.prepare(
      `INSERT INTO profile_memories (id, kind, text, tags, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(m.id, m.kind, m.text, JSON.stringify(m.tags ?? []), m.createdAt);
  }
  for (const s of fixture.skills ?? []) {
    db.prepare(
      `INSERT INTO user_skills (id, title, body_md, triggers_json, source, status, source_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(s.id, s.title, s.body_md, JSON.stringify(s.triggers ?? []),
          s.source, s.status ?? 'active', s.source_summary ?? null,
          s.createdAt, s.updatedAt);
  }
  db.close();
}

test('migrateLegacyToV3: backfills profile_memories rows into the v3 memory table', withFreshHome(async (home) => {
  seedLegacyDb(home, {
    memories: [
      { id: 'mem-1', kind: 'crystallize_memory', text: '用户喜欢手冲咖啡', tags: ['preference'], createdAt: '2026-04-22T10:00:00Z' },
      { id: 'mem-2', kind: 'profile_fact',      text: '用户老板叫 Alex',       tags: ['work'],       createdAt: '2026-04-22T11:00:00Z' },
    ],
  });

  // Trigger ensureSchema → migrateLegacyToV3 by hitting any v3 helper.
  await getProfile();

  const allV3 = await listMemoryV3({ status: 'active', limit: 100 });
  assert.equal(allV3.length, 2);
  const m1 = await getMemoryV3('mem-1');
  assert.ok(m1);
  assert.equal(m1!.text, '用户喜欢手冲咖啡');
  assert.equal(m1!.source, 'legacy:crystallize_memory');
  assert.equal(m1!.subject, 'self');
  assert.equal(m1!.quality, 0.5);                          // default
  assert.deepEqual(m1!.tags, ['preference']);
  // legacy table should be gone
  const dbPath = join(home, 'data', 'proactive.db');
  const db = new Database(dbPath, { readonly: true });
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='profile_memories'",
  ).get();
  db.close();
  assert.equal(exists, undefined);
}));

test('migrateLegacyToV3: backfills user_skills into skill_index + skills/<id>/SKILL.md', withFreshHome(async (home) => {
  seedLegacyDb(home, {
    skills: [
      {
        id: 'coffee', title: 'Pour-over', body_md: '# coffee\nWhen user mentions coffee...',
        triggers: ['mentions coffee'], source: 'manual', status: 'active',
        source_summary: 'auto from chat', createdAt: '2026-04-22T10:00:00Z',
        updatedAt: '2026-04-22T10:00:00Z',
      },
      {
        id: 'noisy-skill', title: 'Old noisy', body_md: '# disabled', triggers: [],
        source: 'crystallize', status: 'disabled',
        createdAt: '2026-04-20T10:00:00Z', updatedAt: '2026-04-21T10:00:00Z',
      },
    ],
  });

  await getProfile();

  // skill_index has both
  const all = await listSkills();
  assert.equal(all.length, 2);
  const coffee = await getSkillIndex('coffee');
  assert.ok(coffee);
  assert.equal(coffee!.status, 'enabled');
  assert.equal(coffee!.source, 'manual');
  assert.equal(coffee!.description, 'auto from chat');
  assert.deepEqual(coffee!.triggers, ['mentions coffee']);

  // Body file exists
  const bodyPath = getSkillBodyPath('coffee');
  assert.ok(existsSync(bodyPath), `expected SKILL.md at ${bodyPath}`);
  const body = readFileSync(bodyPath, 'utf8');
  assert.ok(body.includes('coffee'));

  // Disabled mapping
  const noisy = await getSkillIndex('noisy-skill');
  assert.equal(noisy!.status, 'disabled');

  // Legacy table dropped
  const db = new Database(join(home, 'data', 'proactive.db'), { readonly: true });
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='user_skills'",
  ).get();
  db.close();
  assert.equal(exists, undefined);
}));

test('migrateLegacyToV3: idempotent — running twice does not duplicate', withFreshHome(async (home) => {
  seedLegacyDb(home, {
    memories: [{ id: 'mem-1', kind: 'k', text: 't', createdAt: '2026-04-22T10:00:00Z' }],
  });
  await getProfile();
  const after1 = await listMemoryV3({ limit: 100 });
  // Force re-run by closing and re-opening
  resetDbForTests();
  await getProfile();
  const after2 = await listMemoryV3({ limit: 100 });
  assert.equal(after1.length, after2.length);
}));

test('migrateLegacyToV3: rows already present in v3 (same id) are not re-migrated', withFreshHome(async (home) => {
  seedLegacyDb(home, {
    memories: [{ id: 'mem-1', kind: 'legacy:k', text: '老 text', createdAt: '2026-04-22T10:00:00Z' }],
  });
  // Pre-seed a v3 row at the same id (simulates a partial prior migration)
  const dbPath = join(home, 'data', 'proactive.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memory (
      id TEXT PRIMARY KEY, text TEXT, source TEXT, source_run_id TEXT,
      subject TEXT, quality REAL, confidence REAL, status TEXT, superseded_by TEXT,
      occurred_at TEXT, created_at TEXT, tags_json TEXT, related_memory_ids TEXT,
      reference_count INTEGER, last_referenced_at TEXT, referenced_by_runs TEXT
    );
    INSERT INTO memory (id, text, source, subject, quality, confidence, status,
                        created_at, tags_json, related_memory_ids,
                        reference_count, referenced_by_runs)
    VALUES ('mem-1', '新 text (v3-native)', 'manual', 'self', 0.9, 0.8, 'active',
            '2026-04-23T00:00:00Z', '[]', '[]', 0, '[]');
  `);
  db.close();

  await getProfile();
  const m = await getMemoryV3('mem-1');
  // The pre-existing v3 row should win — legacy not re-imported on top.
  assert.equal(m!.text, '新 text (v3-native)');
  assert.equal(m!.quality, 0.9);
}));
