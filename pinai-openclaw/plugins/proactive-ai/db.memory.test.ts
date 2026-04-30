/**
 * Tests for v3 memory table — sedimented user-fact layer.
 * See docs/plans/memory-architecture.mdx §三 (memory).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addMemoryV3,
  archiveMemoryV3,
  commitConnectorEvolveBatch,
  createEvolutionRun,
  getEvolutionRun,
  getMemoryV3,
  listMemoryV3,
  markMemoryReferenced,
  resetDbForTests,
  supersedeMemoryV3,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-memory-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
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

test('addMemoryV3: persists all fields with defaults', async () => {
  await withTempHome(async () => {
    const m = await addMemoryV3({
      text: '用户喜欢手冲咖啡',
      source: 'crystallize',
      subject: 'topic:coffee',
      quality: 0.85,
      tags: ['preference', 'food'],
    });
    assert.equal(m.text, '用户喜欢手冲咖啡');
    assert.equal(m.source, 'crystallize');
    assert.equal(m.subject, 'topic:coffee');
    assert.equal(m.quality, 0.85);
    assert.equal(m.confidence, 0.5);
    assert.equal(m.status, 'active');
    assert.deepEqual(m.tags, ['preference', 'food']);
    assert.equal(m.reference_count, 0);
    assert.deepEqual(m.referenced_by_runs, []);
  });
});

test('addMemoryV3: device:trigger source caps quality at 0.7', async () => {
  await withTempHome(async () => {
    const m = await addMemoryV3({
      text: 'home → office, 25 min',
      source: 'device:trigger',
      quality: 0.95,           // request 0.95
    });
    assert.equal(m.quality, 0.7);
  });
});

test('addMemoryV3: non-device source is not capped', async () => {
  await withTempHome(async () => {
    const m = await addMemoryV3({
      text: 'high quality fact',
      source: 'evolution:dream',
      quality: 0.95,
    });
    assert.equal(m.quality, 0.95);
  });
});

test('addMemoryV3: clamps quality to [0,1]', async () => {
  await withTempHome(async () => {
    const above = await addMemoryV3({ text: 'x', source: 'manual', quality: 1.5 });
    const below = await addMemoryV3({ text: 'y', source: 'manual', quality: -0.3 });
    assert.equal(above.quality, 1);
    assert.equal(below.quality, 0);
  });
});

test('addMemoryV3: throws on empty text or source', async () => {
  await withTempHome(async () => {
    await assert.rejects(addMemoryV3({ text: '', source: 'manual' }), /text is required/);
    await assert.rejects(addMemoryV3({ text: 'hi', source: '' }), /source is required/);
  });
});

test('listMemoryV3: filters by status, quality, source, subjectPrefix', async () => {
  await withTempHome(async () => {
    await addMemoryV3({ text: 'a', source: 'crystallize', subject: 'topic:health', quality: 0.6 });
    await addMemoryV3({ text: 'b', source: 'crystallize', subject: 'topic:work', quality: 0.85 });
    await addMemoryV3({ text: 'c', source: 'manual', subject: 'person:zhang@x.com', quality: 0.4 });
    await addMemoryV3({ text: 'd', source: 'manual', subject: 'person:li@x.com', quality: 0.9 });

    const high = await listMemoryV3({ minQuality: 0.7 });
    assert.equal(high.length, 2);
    assert.deepEqual(high.map((m) => m.text).sort(), ['b', 'd']);

    const persons = await listMemoryV3({ subjectPrefix: 'person:' });
    assert.equal(persons.length, 2);

    const cryst = await listMemoryV3({ source: 'crystallize' });
    assert.equal(cryst.length, 2);
  });
});

test('listMemoryV3: orderBy quality desc by default returns highest first', async () => {
  await withTempHome(async () => {
    await addMemoryV3({ text: 'low', source: 'manual', quality: 0.3 });
    await addMemoryV3({ text: 'mid', source: 'manual', quality: 0.6 });
    await addMemoryV3({ text: 'high', source: 'manual', quality: 0.9 });
    const results = await listMemoryV3({ orderBy: 'quality' });
    assert.deepEqual(results.map((m) => m.text), ['high', 'mid', 'low']);
  });
});

test('listMemoryV3: only returns active by default', async () => {
  await withTempHome(async () => {
    const a = await addMemoryV3({ text: 'a', source: 'manual' });
    await addMemoryV3({ text: 'b', source: 'manual' });
    await archiveMemoryV3(a.id);
    const active = await listMemoryV3();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.text, 'b');
    const archived = await listMemoryV3({ status: 'archived' });
    assert.equal(archived.length, 1);
    assert.equal(archived[0]!.id, a.id);
  });
});

test('supersedeMemoryV3: links old → new, marks old superseded', async () => {
  await withTempHome(async () => {
    const a = await addMemoryV3({ text: 'old fact', source: 'manual' });
    const b = await addMemoryV3({ text: 'new fact', source: 'manual' });
    await supersedeMemoryV3(a.id, b.id);
    const aRow = await getMemoryV3(a.id);
    assert.equal(aRow!.status, 'superseded');
    assert.equal(aRow!.superseded_by, b.id);
    const bRow = await getMemoryV3(b.id);
    assert.equal(bRow!.status, 'active');
  });
});

test('supersedeMemoryV3: throws if either id is missing', async () => {
  await withTempHome(async () => {
    const a = await addMemoryV3({ text: 'x', source: 'manual' });
    await assert.rejects(supersedeMemoryV3(a.id, 'no-such'), /not found/);
    await assert.rejects(supersedeMemoryV3('no-such', a.id), /not found/);
    await assert.rejects(supersedeMemoryV3(a.id, a.id), /same/);
  });
});

test('markMemoryReferenced: bumps count, dedupes runIds, caps at 10', async () => {
  await withTempHome(async () => {
    const m = await addMemoryV3({ text: 'x', source: 'manual' });
    await markMemoryReferenced([m.id], 'run-1');
    await markMemoryReferenced([m.id], 'run-1'); // dedupe — same run
    await markMemoryReferenced([m.id], 'run-2');

    const row = await getMemoryV3(m.id);
    assert.equal(row!.reference_count, 3);          // count always bumps
    assert.deepEqual(row!.referenced_by_runs, ['run-1', 'run-2']); // dedupe in list

    // Push past cap
    for (let i = 3; i <= 15; i++) {
      await markMemoryReferenced([m.id], `run-${i}`);
    }
    const after = await getMemoryV3(m.id);
    assert.equal(after!.referenced_by_runs.length, 10);
    // Newest 10 should be retained (run-6 .. run-15)
    assert.equal(after!.referenced_by_runs[after!.referenced_by_runs.length - 1], 'run-15');
  });
});

test('markMemoryReferenced: missing memory id is silently skipped', async () => {
  await withTempHome(async () => {
    const m = await addMemoryV3({ text: 'x', source: 'manual' });
    const updated = await markMemoryReferenced([m.id, 'no-such'], 'run-1');
    assert.equal(updated, 1); // only the real one
  });
});

test('markMemoryReferenced: empty inputs are no-op', async () => {
  await withTempHome(async () => {
    assert.equal(await markMemoryReferenced([], 'run-1'), 0);
    const m = await addMemoryV3({ text: 'x', source: 'manual' });
    assert.equal(await markMemoryReferenced([m.id], ''), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// commitConnectorEvolveBatch — atomic batch writer for connector-evolve.
// ─────────────────────────────────────────────────────────────────────────

test('commitConnectorEvolveBatch: writes memories + delta + refs + reference 三件套 in one shot', async () => {
  await withTempHome(async () => {
    const run = await createEvolutionRun({
      triggerKind: 'on_event',
      contextSummary: 'connector.init gmail batch',
    });

    const result = await commitConnectorEvolveBatch({
      evolutionRunId: run.id,
      memories: [
        { text: 'works at PINAI', source: 'connector_init:gmail', sourceRunId: run.id, subject: 'work:employer', quality: 0.7 },
        { text: 'lives in Shanghai', source: 'connector_init:gmail', sourceRunId: run.id, subject: 'fact:city', quality: 0.6 },
      ],
    });

    assert.equal(result.memoriesWritten, 2);
    assert.equal(result.memoriesSuperseded, 0);
    assert.equal(result.memoryIds.length, 2);
    assert.equal(result.perItem.length, 2);
    assert.equal(result.perItem[0]!.supersededOldId, null);

    // Memory rows are persisted, active, with reference 三件套 initialized.
    const row1 = await getMemoryV3(result.memoryIds[0]!);
    assert.equal(row1!.text, 'works at PINAI');
    assert.equal(row1!.status, 'active');
    assert.equal(row1!.source_run_id, run.id);
    assert.equal(row1!.reference_count, 1);
    assert.deepEqual(row1!.referenced_by_runs, [run.id]);
    assert.notEqual(row1!.last_referenced_at, null);

    // evolution_run delta + refs_produced both reflect the batch.
    const updated = await getEvolutionRun(run.id);
    assert.equal(updated!.memories_written, 2);
    assert.equal(updated!.memories_superseded, 0);
    assert.deepEqual(updated!.refs_produced['memory'], result.memoryIds);
  });
});

test('commitConnectorEvolveBatch: applies supersedes to existing memory rows', async () => {
  await withTempHome(async () => {
    const oldMem = await addMemoryV3({ text: 'old role: junior eng', source: 'manual', subject: 'work:role' });

    const run = await createEvolutionRun({ triggerKind: 'on_event', contextSummary: 'role update' });
    const result = await commitConnectorEvolveBatch({
      evolutionRunId: run.id,
      memories: [
        { text: 'role: senior eng', source: 'connector_init:gmail', sourceRunId: run.id, subject: 'work:role', supersedes: oldMem.id },
      ],
    });

    assert.equal(result.memoriesSuperseded, 1);
    assert.equal(result.perItem[0]!.supersededOldId, oldMem.id);

    const oldRow = await getMemoryV3(oldMem.id);
    assert.equal(oldRow!.status, 'superseded');
    assert.equal(oldRow!.superseded_by, result.memoryIds[0]);

    const updated = await getEvolutionRun(run.id);
    assert.equal(updated!.memories_superseded, 1);
  });
});

test('commitConnectorEvolveBatch: bogus supersedes id is silently dropped, batch still lands', async () => {
  await withTempHome(async () => {
    const run = await createEvolutionRun({ triggerKind: 'on_event', contextSummary: 'hallucinated supersede' });
    const result = await commitConnectorEvolveBatch({
      evolutionRunId: run.id,
      memories: [
        { text: 'fact A', source: 'connector_init:gmail', sourceRunId: run.id, supersedes: 'no-such-id' },
        { text: 'fact B', source: 'connector_init:gmail', sourceRunId: run.id },
      ],
    });

    // Both memories land; the bogus supersede is reported as null.
    assert.equal(result.memoriesWritten, 2);
    assert.equal(result.memoriesSuperseded, 0);
    assert.equal(result.perItem[0]!.supersededOldId, null);
    assert.equal(result.perItem[1]!.supersededOldId, null);
  });
});

test('commitConnectorEvolveBatch: empty memories array is a no-op', async () => {
  await withTempHome(async () => {
    const run = await createEvolutionRun({ triggerKind: 'on_event', contextSummary: 'empty' });
    const result = await commitConnectorEvolveBatch({ evolutionRunId: run.id, memories: [] });
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.memoryIds.length, 0);

    const updated = await getEvolutionRun(run.id);
    assert.equal(updated!.memories_written, 0);
    assert.deepEqual(updated!.refs_produced, {});
  });
});

test('commitConnectorEvolveBatch: missing required fields throw before any write', async () => {
  await withTempHome(async () => {
    const run = await createEvolutionRun({ triggerKind: 'on_event', contextSummary: 'validation' });

    await assert.rejects(
      () => commitConnectorEvolveBatch({
        evolutionRunId: run.id,
        memories: [
          { text: 'good', source: 'connector_init:gmail', sourceRunId: run.id },
          { text: '', source: 'connector_init:gmail', sourceRunId: run.id },
        ],
      }),
      /memory.text is required/,
    );

    // Validation runs before the transaction opens, so nothing is written.
    const updated = await getEvolutionRun(run.id);
    assert.equal(updated!.memories_written, 0);
    assert.deepEqual(updated!.refs_produced, {});
  });
});
