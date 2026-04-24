/**
 * Tests for v3 skill_index — index in DB, body markdown in folder.
 * See docs/plans/memory-architecture.mdx §三 (skill_index).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addSkill,
  disableSkill,
  enableSkill,
  getSkillIndex,
  getSkillBodyPath,
  getSkillFolder,
  getSkillsDir,
  listSkills,
  markSkillReferenced,
  readSkillBody,
  resetDbForTests,
  updateSkill,
} from './db.ts';

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-skill-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn(root);
  } finally {
    resetDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const BODY_V1 = '# Coffee maker\n\nWhen the user mentions coffee, suggest pour-over.\n';
const BODY_V2 = '# Coffee maker\n\nWhen user mentions coffee, suggest pour-over OR cold brew.\n';

test('addSkill: writes SKILL.md and indexes metadata', async () => {
  await withTempHome(async (root) => {
    const skill = await addSkill({
      id: 'coffee-pour-over',
      title: 'Pour-over suggestion',
      body: BODY_V1,
      description: 'Coffee skill',
      triggers: ['mentions coffee'],
      source: 'manual',
    });
    assert.equal(skill.id, 'coffee-pour-over');
    assert.equal(skill.title, 'Pour-over suggestion');
    assert.equal(skill.status, 'enabled');
    assert.equal(skill.revision, 1);
    assert.deepEqual(skill.triggers, ['mentions coffee']);
    assert.equal(skill.source, 'manual');
    assert.ok(skill.body_hash.length > 10);

    // File should exist on disk
    const expectedDir = join(root, 'data', 'skills', 'coffee-pour-over');
    assert.equal(getSkillsDir(), join(root, 'data', 'skills'));
    assert.equal(getSkillFolder('coffee-pour-over'), expectedDir);
    assert.ok(existsSync(getSkillBodyPath('coffee-pour-over')));
    assert.equal(await readFile(getSkillBodyPath('coffee-pour-over'), 'utf8'), BODY_V1);
    assert.equal(readSkillBody('coffee-pour-over'), BODY_V1);
  });
});

test('addSkill: throws on missing required fields', async () => {
  await withTempHome(async () => {
    await assert.rejects(
      addSkill({ id: '', title: 't', body: 'b', source: 'manual' }),
      /id is required/,
    );
    await assert.rejects(
      addSkill({ id: 'a', title: '', body: 'b', source: 'manual' }),
      /title is required/,
    );
    await assert.rejects(
      addSkill({ id: 'a', title: 't', body: 'b', source: '' }),
      /source is required/,
    );
  });
});

test('updateSkill: changing body increments revision and rewrites file', async () => {
  await withTempHome(async () => {
    const v1 = await addSkill({
      id: 'c', title: 'Coffee', body: BODY_V1, source: 'manual',
    });
    const v2 = await updateSkill({
      id: 'c', body: BODY_V2, lastUpdatedRunId: 'run-evol-42',
    });
    assert.equal(v2.revision, 2);
    assert.notEqual(v2.body_hash, v1.body_hash);
    assert.equal(v2.last_updated_run_id, 'run-evol-42');
    assert.equal(readSkillBody('c'), BODY_V2);
  });
});

test('updateSkill: identical body does NOT bump revision', async () => {
  await withTempHome(async () => {
    await addSkill({ id: 'c', title: 'C', body: BODY_V1, source: 'manual' });
    const updated = await updateSkill({ id: 'c', body: BODY_V1 });
    assert.equal(updated.revision, 1);
  });
});

test('updateSkill: title / description / triggers update without bumping revision', async () => {
  await withTempHome(async () => {
    await addSkill({ id: 'c', title: 'old title', body: BODY_V1, source: 'manual' });
    const updated = await updateSkill({
      id: 'c',
      title: 'new title',
      description: 'updated desc',
      triggers: ['t1', 't2'],
    });
    assert.equal(updated.title, 'new title');
    assert.equal(updated.description, 'updated desc');
    assert.deepEqual(updated.triggers, ['t1', 't2']);
    assert.equal(updated.revision, 1);
  });
});

test('updateSkill: throws on unknown id', async () => {
  await withTempHome(async () => {
    await assert.rejects(updateSkill({ id: 'no-such', title: 'x' }), /not found/);
  });
});

test('disable / enable cycle updates status and timestamps', async () => {
  await withTempHome(async () => {
    await addSkill({ id: 'c', title: 'C', body: BODY_V1, source: 'manual' });
    const disabled = await disableSkill('c');
    assert.equal(disabled.status, 'disabled');
    assert.ok(disabled.disabled_at);
    const enabled = await enableSkill('c');
    assert.equal(enabled.status, 'enabled');
    assert.ok(enabled.enabled_at);
    assert.equal(enabled.disabled_at, null);
  });
});

test('listSkills: filters by status and source', async () => {
  await withTempHome(async () => {
    await addSkill({ id: 'a', title: 'A', body: 'a', source: 'manual', status: 'enabled' });
    await addSkill({ id: 'b', title: 'B', body: 'b', source: 'crystallize', status: 'enabled' });
    await addSkill({ id: 'c', title: 'C', body: 'c', source: 'manual', status: 'disabled' });

    const enabledManual = await listSkills({ status: 'enabled', source: 'manual' });
    assert.equal(enabledManual.length, 1);
    assert.equal(enabledManual[0]!.id, 'a');

    const allEnabled = await listSkills({ status: 'enabled' });
    assert.equal(allEnabled.length, 2);
  });
});

test('getSkillIndex: missing returns null', async () => {
  await withTempHome(async () => {
    assert.equal(await getSkillIndex('no-such'), null);
  });
});

test('readSkillBody: missing returns null', async () => {
  await withTempHome(async () => {
    assert.equal(readSkillBody('no-such'), null);
  });
});

test('markSkillReferenced: bumps count + dedupes + caps at 10', async () => {
  await withTempHome(async () => {
    const s = await addSkill({ id: 'c', title: 'C', body: 'b', source: 'manual' });
    await markSkillReferenced([s.id], 'run-1');
    await markSkillReferenced([s.id], 'run-1');
    await markSkillReferenced([s.id], 'run-2');

    const row = await getSkillIndex(s.id);
    assert.equal(row!.reference_count, 3);
    assert.deepEqual(row!.referenced_by_runs, ['run-1', 'run-2']);

    for (let i = 3; i <= 15; i++) {
      await markSkillReferenced([s.id], `run-${i}`);
    }
    const after = await getSkillIndex(s.id);
    assert.equal(after!.referenced_by_runs.length, 10);
  });
});
