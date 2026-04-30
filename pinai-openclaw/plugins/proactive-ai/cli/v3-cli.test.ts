/**
 * Tests for the v3 CLI domains: memory, signals, raw, evolution, skills.
 * Each handler returns a JSON envelope (see cli/shared.ts).
 *
 * See docs/plans/memory-architecture.mdx §六.
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
  ingestDeviceHealthObservations,
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

test('pin memory add: refuses missing text; source defaults to manual', async () => {
  await withTempHome(async () => {
    // No text → fail
    const noText = decode(await handleMemory(['add', '--source', 'manual']));
    assert.equal(noText.ok, false);
    // Text without --source is fine — defaults to source=manual so one-shot calls work
    const noSource = decode(await handleMemory(['add', '--text', 'hi']));
    assert.equal(noSource.ok, true);
    assert.equal(noSource.data.memory.source, 'manual');
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

test('pin memory list: invalid --quality value fails loud, not silent 0 rows', async () => {
  await withTempHome(async () => {
    await handleMemory(['add', '--text', 'investment fact', '--source', 'manual', '--quality', '0.8']);
    // Sanity: valid number works
    const ok = decode(await handleMemory(['list', '--quality', '0.7']));
    assert.equal(ok.data.count, 1);
    // Invalid "0.7+" used to coerce to NaN and return 0 silently — must now fail
    const bad = decode(await handleMemory(['list', '--quality', '0.7+']));
    assert.equal(bad.ok, false);
    assert.ok(bad.error.message.includes('Invalid --quality'));
  });
});

test('pin memory search: --top is accepted as an alias of --limit', async () => {
  await withTempHome(async () => {
    await handleMemory(['add', '--text', '投资 a', '--source', 'manual']);
    await handleMemory(['add', '--text', '投资 b', '--source', 'manual']);
    const limited = decode(await handleMemory(['search', '--query', '投资', '--top', '1']));
    assert.equal(limited.data.count, 1);
  });
});

test('pin memory add: text as positional arg, source defaults to manual', async () => {
  await withTempHome(async () => {
    const out = decode(await handleMemory(['add', '用户喜欢咖啡', '--quality', '0.6', '--subject', 'topic:coffee']));
    assert.equal(out.ok, true);
    assert.equal(out.data.memory.text, '用户喜欢咖啡');
    assert.equal(out.data.memory.source, 'manual');
    assert.equal(out.data.memory.subject, 'topic:coffee');
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

test('pin signals recent: excludes future-dated signals', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      { kind: 'm', title: 'now', summary: 'n', occurredAt: new Date(Date.now() - 60_000).toISOString() },
      { kind: 'm', title: 'future', summary: 'f', occurredAt: '2100-01-01T00:00:00Z' },
    ]);

    const r = decode(await handleSignals(['recent', '--hours', '24']));

    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1);
    assert.equal(r.data.signals[0].title, 'now');
    assert.equal(typeof r.data.until, 'string');
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

test('pin raw device-contacts search filters by query', async () => {
  await withTempHome(async () => {
    const { ingestDeviceContactsSnapshot } = await import('../raw-db.ts');
    ingestDeviceContactsSnapshot({
      deviceId: 'dev-1',
      contacts: [
        { displayName: '妈妈', emails: ['mom@x.com'] },
        { displayName: 'Alex Chen', emails: ['alex@co.com'] },
        { displayName: '张三', phones: ['+8613800000000'] },
      ],
    });
    // list all
    const all = decode(await handleRaw(['device-contacts', 'list', '--deviceId', 'dev-1']));
    assert.equal(all.data.count, 3);
    // search 张 — should match only 张三
    const zhang = decode(await handleRaw(['device-contacts', 'search', '--query', '张', '--deviceId', 'dev-1']));
    assert.equal(zhang.data.count, 1);
    assert.equal(zhang.data.contacts[0].display_name, '张三');
    // search email partial
    const alex = decode(await handleRaw(['device-contacts', 'search', '--query', 'alex@', '--deviceId', 'dev-1']));
    assert.equal(alex.data.count, 1);
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

test('pin raw device-health list returns health observations', async () => {
  await withTempHome(async () => {
    ingestDeviceHealthObservations({
      deviceId: 'watch-1',
      observations: [
        { observationType: 'daily_summary', metric: 'steps', value: 8120, unit: 'count', localDate: '2026-04-30' },
        { observationType: 'sample', metric: 'heart_rate', value: 72, unit: 'bpm', startAt: '2026-04-30T09:59:00Z' },
      ],
    });

    const r = decode(await handleRaw([
      'device-health', 'list',
      '--deviceId', 'watch-1',
      '--localDate', '2026-04-30',
    ]));

    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1);
    assert.equal(r.data.observations[0].metric, 'steps');
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
