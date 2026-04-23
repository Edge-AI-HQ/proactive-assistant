/**
 * Tests for the v3 CLI domains: memory, signals, raw, evolution, skills.
 * Each handler returns a JSON envelope (see cli/shared.ts).
 *
 * See docs/memory-architecture.md §六.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleMemory } from './memory.ts';
import { handleSignals } from './signals.ts';
import { handleRaw } from './raw.ts';
import { handleEvolution } from './evolution.ts';
import { handleSkills } from './skills.ts';

import {
  ingestPersonalSignals,
  resetDbForTests,
} from '../db.ts';
import {
  ingestGmailMessages,
  ingestDeviceAppsSnapshot,
  resetRawDbForTests,
} from '../raw-db.ts';

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-v3-cli-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  try {
    return await fn(root);
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function decode(raw: string): { ok: boolean; data: any; error: any } {
  return JSON.parse(raw);
}

// ─── pin memory ────────────────────────────────────────────────────────

test('pin memory help: lists subcommands', async () => {
  await withTempHome(async () => {
    const r = decode(await handleMemory(['help']));
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data.commands));
    assert.ok(r.data.commands.includes('list'));
  });
});

test('pin memory add then list and search', async () => {
  await withTempHome(async () => {
    const add = decode(await handleMemory([
      'add', '--text', '用户喜欢手冲咖啡', '--source', 'manual',
      '--subject', 'topic:coffee', '--quality', '0.85', '--tags', 'preference,food',
    ]));
    assert.equal(add.ok, true);
    assert.equal(add.data.memory.text, '用户喜欢手冲咖啡');
    assert.equal(add.data.memory.quality, 0.85);
    assert.deepEqual(add.data.memory.tags, ['preference', 'food']);

    const list = decode(await handleMemory(['list', '--minQuality', '0.5']));
    assert.equal(list.data.count, 1);

    const search = decode(await handleMemory(['search', '--query', '咖啡']));
    assert.equal(search.data.count, 1);
  });
});

test('pin memory add: refuses missing text or source', async () => {
  await withTempHome(async () => {
    const r1 = decode(await handleMemory(['add', '--source', 'manual']));
    assert.equal(r1.ok, false);
    const r2 = decode(await handleMemory(['add', '--text', 'hi']));
    assert.equal(r2.ok, false);
  });
});

test('pin memory archive then list returns empty active', async () => {
  await withTempHome(async () => {
    const a = decode(await handleMemory(['add', '--text', 'x', '--source', 'manual']));
    const id = a.data.memory.id;
    const archive = decode(await handleMemory(['archive', '--id', id]));
    assert.equal(archive.ok, true);
    const list = decode(await handleMemory(['list']));
    assert.equal(list.data.count, 0);
    const archived = decode(await handleMemory(['list', '--status', 'archived']));
    assert.equal(archived.data.count, 1);
  });
});

test('pin memory supersede links rows', async () => {
  await withTempHome(async () => {
    const a = decode(await handleMemory(['add', '--text', 'old', '--source', 'manual']));
    const b = decode(await handleMemory(['add', '--text', 'new', '--source', 'manual']));
    const sup = decode(await handleMemory([
      'supersede', '--old', a.data.memory.id, '--new', b.data.memory.id,
    ]));
    assert.equal(sup.ok, true);
    const get = decode(await handleMemory(['get', '--id', a.data.memory.id]));
    assert.equal(get.data.memory.status, 'superseded');
    assert.equal(get.data.memory.superseded_by, b.data.memory.id);
  });
});

// ─── pin signals ──────────────────────────────────────────────────────

test('pin signals recent: filters by hours window', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      { kind: 'm', title: 'old', summary: 'o', occurredAt: '2020-01-01T00:00:00Z' },
      { kind: 'm', title: 'new', summary: 'n' },           // now
    ]);
    const r = decode(await handleSignals(['recent', '--hours', '24']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1);                          // only 'new'
    assert.equal(r.data.signals[0].title, 'new');
  });
});

test('pin signals consume: requires --id and --runId', async () => {
  await withTempHome(async () => {
    const ing = await ingestPersonalSignals([{ kind: 'm', title: 't', summary: 's' }]);
    const id = ing.ids[0]!;
    const r1 = decode(await handleSignals(['consume', '--id', id]));
    assert.equal(r1.ok, false);
    const r2 = decode(await handleSignals(['consume', '--id', id, '--runId', 'run-1']));
    assert.equal(r2.ok, true);
    assert.equal(r2.data.updated, 1);
  });
});

// ─── pin raw ──────────────────────────────────────────────────────────

test('pin raw gmail recent returns ingested rows', async () => {
  await withTempHome(async () => {
    ingestGmailMessages([
      { messageId: 'm1', subject: 'Welcome', occurredAt: new Date().toISOString() },
    ]);
    const r = decode(await handleRaw(['gmail', 'recent', '--hours', '24']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1);
  });
});

test('pin raw device-apps shows latest snapshot', async () => {
  await withTempHome(async () => {
    ingestDeviceAppsSnapshot({
      deviceId: 'dev-1',
      apps: [
        { bundleId: 'com.x', appName: 'X' },
        { bundleId: 'com.y', appName: 'Y' },
      ],
    });
    const r = decode(await handleRaw(['device-apps', '--deviceId', 'dev-1', '--top', '10']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 2);
  });
});

// ─── pin evolution ────────────────────────────────────────────────────

test('pin evolution full lifecycle: create → delta → refs → complete', async () => {
  await withTempHome(async () => {
    const create = decode(await handleEvolution([
      'create', '--triggerKind', 'manual', '--contextSummary', 'CLI smoke',
    ]));
    assert.equal(create.ok, true);
    const id = create.data.run.id;

    const delta = decode(await handleEvolution([
      'delta', '--id', id, '--memoriesWritten', '3', '--skillsAdded', '1',
    ]));
    assert.equal(delta.ok, true);

    const refsCons = decode(await handleEvolution([
      'refs', 'consumed', '--id', id, '--table', 'personal_signals', '--ids', 's1,s2',
    ]));
    assert.equal(refsCons.ok, true);

    const refsProd = decode(await handleEvolution([
      'refs', 'produced', '--id', id, '--table', 'memory', '--ids', 'm1,m2,m3',
    ]));
    assert.equal(refsProd.ok, true);

    const complete = decode(await handleEvolution([
      'complete', '--id', id, '--llmTokens', '999', '--durationMs', '5000',
    ]));
    assert.equal(complete.ok, true);
    assert.equal(complete.data.run.status, 'completed');
    assert.equal(complete.data.run.memories_written, 3);
    assert.equal(complete.data.run.llm_tokens, 999);
    assert.deepEqual(complete.data.run.refs_consumed, { personal_signals: ['s1', 's2'] });
  });
});

test('pin evolution recent: filters by trigger kind', async () => {
  await withTempHome(async () => {
    await handleEvolution(['create', '--triggerKind', 'daily_dream']);
    await handleEvolution(['create', '--triggerKind', 'chat_burst']);
    const dreams = decode(await handleEvolution([
      'recent', '--kind', 'daily_dream', '--limit', '10',
    ]));
    assert.equal(dreams.data.count, 1);
  });
});

// ─── pin skills ───────────────────────────────────────────────────────

test('pin skills add (with --body) → list → show prints body', async () => {
  await withTempHome(async () => {
    const add = decode(await handleSkills([
      'add', '--id', 'coffee', '--title', 'Coffee', '--source', 'manual',
      '--body', '# Coffee skill\nWhen coffee...',
    ]));
    assert.equal(add.ok, true);
    assert.equal(add.data.skill.id, 'coffee');

    const list = decode(await handleSkills(['list']));
    assert.equal(list.data.count, 1);

    const show = decode(await handleSkills(['show', '--id', 'coffee']));
    assert.ok(show.data.body.includes('Coffee skill'));
  });
});

test('pin skills add (with --from-file) reads body file', async () => {
  await withTempHome(async (root) => {
    const filePath = join(root, 'tmp-skill.md');
    await writeFile(filePath, '# From file\nbody\n', 'utf8');
    const add = decode(await handleSkills([
      'add', '--id', 'fromfile', '--title', 'FF', '--source', 'manual',
      '--from-file', filePath,
    ]));
    assert.equal(add.ok, true);
    const show = decode(await handleSkills(['show', '--id', 'fromfile']));
    assert.ok(show.data.body.includes('From file'));
  });
});

test('pin skills disable then enable cycles status', async () => {
  await withTempHome(async () => {
    await handleSkills([
      'add', '--id', 'c', '--title', 'C', '--source', 'manual', '--body', 'b',
    ]);
    const dis = decode(await handleSkills(['disable', '--id', 'c']));
    assert.equal(dis.data.skill.status, 'disabled');
    const en = decode(await handleSkills(['enable', '--id', 'c']));
    assert.equal(en.data.skill.status, 'enabled');
  });
});
