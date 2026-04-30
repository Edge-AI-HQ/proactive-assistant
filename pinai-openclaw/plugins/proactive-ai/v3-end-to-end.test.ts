/**
 * End-to-end smoke test: simulates the complete v3 data flow.
 *
 *   Device upload → personal_signals + snapshot bridge to raw.db
 *   ↓
 *   evolution_run created
 *   ↓
 *   Read signals + raw → "extract" memory (manually here)
 *   ↓
 *   Mark signals consumed, refs_consumed/produced recorded
 *   ↓
 *   Pipeline reads memory + signals + skills via the same DB layer
 *   ↓
 *   Reference triple bumped on rows the pipeline used
 *
 * No live LLM, no HTTP server — this exercises the integrated DB layer
 * to confirm the plumbing is end-to-end correct.
 *
 * See docs/plans/memory-architecture.mdx §四 (data-flow scenarios).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestDeviceItems } from './routes/devices.ts';
import {
  addMemoryV3,
  completeEvolutionRun,
  createEvolutionRun,
  getEvolutionRun,
  getMemoryV3,
  ingestPersonalSignals,
  listMemoryV3,
  listPersonalSignals,
  markMemoryReferenced,
  markPersonalSignalsConsumed,
  recordEvolutionDelta,
  recordEvolutionRefsConsumed,
  recordEvolutionRefsProduced,
  resetDbForTests,
} from './db.ts';
import {
  ingestGmailMessages,
  listDeviceApps,
  listGmailMessages,
  markRawReferenced,
  resetRawDbForTests,
} from './raw-db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-v3-e2e-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  try {
    return await fn();
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

test('e2e: device GPS-trigger event flows through to a high-quality memory', async () => {
  await withTempHome(async () => {
    // 1. Device side: edge model fires "home → office" trigger.
    //    The mobile SDK posts the item to /api/proxy/devices/ingest,
    //    which calls ingestDeviceItems on the server.
    await ingestDeviceItems('iphone-1', [{
      id: 'mob-1',
      itemType: 'moment',
      title: 'home → office',
      summary: '从家到公司，用时 25 分钟（比平时晚 10 分钟）',
      salience: 0.65,
      confidence: 0.7,
      dedupeKey: 'device:loc:home_to_office:2026-04-23',
      occurredAt: '2026-04-23T08:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      payload: { from: 'place:home', to: 'place:office', duration_min: 25 },
    }]);

    // Personal_signals row should be present, status='open'.
    const openSignals = await listPersonalSignals({ status: 'open' });
    assert.equal(openSignals.length, 1);
    const signal = openSignals[0]!;
    assert.equal(signal.kind, 'moment');
    assert.equal(signal.salience, 0.65);
    assert.equal(signal.device_id, 'iphone-1');

    // 2. Pipeline run starts; it consumes recent signals to build context.
    const pipelineRunId = 'pipeline-run-1';
    await markMemoryReferenced([], pipelineRunId);    // no memories yet, no-op

    // 3. Hours later: the daily evolution agent runs.
    const evol = await createEvolutionRun({
      triggerKind: 'daily_dream',
      windowStart: '2026-04-23T00:00:00Z',
      windowEnd: '2026-04-24T00:00:00Z',
      contextSummary: 'pulled 1 location signal in the last 24h',
    });

    // 4. Evolution agent reads the signal, derives a memory.
    await recordEvolutionRefsConsumed(evol.id, 'personal_signals', [signal.id]);
    const newMemory = await addMemoryV3({
      text: '用户工作日 8:00 通勤上班（基于一周 GPS 模式）',
      source: 'extract:device_signals',
      sourceRunId: evol.id,
      subject: 'self',
      quality: 0.75,                                  // higher than device cap (0.7)
      tags: ['routine', 'commute'],
    });
    await recordEvolutionRefsProduced(evol.id, 'memory', [newMemory.id]);

    // 5. Mark the consumed signal so future evolution runs skip it.
    const consumed = await markPersonalSignalsConsumed([signal.id], evol.id);
    assert.equal(consumed, 1);

    await recordEvolutionDelta(evol.id, {
      memoriesWritten: 1,
      signalsConsumed: 1,
    });
    await completeEvolutionRun(evol.id, { llmTokens: 1500, durationMs: 6000 });

    // ─── Verify the trajectory ───────────────────────────────────────
    const finalRun = await getEvolutionRun(evol.id);
    assert.equal(finalRun!.status, 'completed');
    assert.equal(finalRun!.memories_written, 1);
    assert.equal(finalRun!.signals_consumed, 1);
    assert.deepEqual(finalRun!.refs_consumed, { personal_signals: [signal.id] });
    assert.deepEqual(finalRun!.refs_produced, { memory: [newMemory.id] });

    // The signal is now consumed; default open-only listing returns nothing.
    assert.equal((await listPersonalSignals({ status: 'open' })).length, 0);
    assert.equal((await listPersonalSignals({ status: 'consumed' })).length, 1);

    // The memory exists and is reachable by the next pipeline run.
    const recentMemories = await listMemoryV3({ minQuality: 0.7 });
    assert.equal(recentMemories.length, 1);
    assert.equal(recentMemories[0]!.text, newMemory.text);
    assert.equal(recentMemories[0]!.source_run_id, evol.id);

    // 6. Next pipeline run reads + references the new memory.
    const nextPipelineRun = 'pipeline-run-2';
    await markMemoryReferenced([newMemory.id], nextPipelineRun);
    const refRow = await getMemoryV3(newMemory.id);
    assert.equal(refRow!.reference_count, 1);
    assert.deepEqual(refRow!.referenced_by_runs, [nextPipelineRun]);
  });
});

test('e2e: device app inventory snapshot flows to raw.db, not memory', async () => {
  await withTempHome(async () => {
    // Device pushes a full app-inventory snapshot.
    await ingestDeviceItems('iphone-1', [{
      id: 'snap-1',
      itemType: 'app_inventory_bootstrap',
      title: 'Apps installed',
      summary: '40 apps',
      salience: 0.5,
      occurredAt: '2026-04-23T08:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      payload: {
        apps: [
          { bundleId: 'com.tencent.wechat', appName: 'WeChat' },
          { bundleId: 'com.robinhood.android', appName: 'Robinhood' },
          { bundleId: 'com.spotify.music', appName: 'Spotify' },
        ],
      },
    }]);

    // raw.db.device_apps_snapshot should hold per-app rows
    const apps = listDeviceApps({ deviceId: 'iphone-1', latestSnapshotOnly: true });
    assert.equal(apps.length, 3);

    // No memory yet — evolution agent hasn't run
    assert.equal((await listMemoryV3()).length, 0);

    // Evolution agent reads raw, extracts insight memories
    const evol = await createEvolutionRun({ triggerKind: 'daily_dream' });
    await recordEvolutionRefsConsumed(evol.id, 'device_apps_snapshot', apps.map((a) => a.id));
    const investingMemory = await addMemoryV3({
      text: '用户关注个人投资（装了 Robinhood）',
      source: 'extract:device_apps',
      sourceRunId: evol.id,
      subject: 'topic:investing',
      quality: 0.6,
    });
    await recordEvolutionRefsProduced(evol.id, 'memory', [investingMemory.id]);
    markRawReferenced('device_apps_snapshot', apps.map((a) => a.id), evol.id);
    await completeEvolutionRun(evol.id);

    // Now next pipeline run reads memory (not raw) for cards
    const memoriesForPipeline = await listMemoryV3({ minQuality: 0.5 });
    assert.equal(memoriesForPipeline.length, 1);
    assert.equal(memoriesForPipeline[0]!.subject, 'topic:investing');
  });
});

test('e2e: legacy addUserSkill writes both user_skills and skill_index + folder', async () => {
  await withTempHome(async () => {
    const { addUserSkill, listSkills, readSkillBody } = await import('./db.ts');
    const skill = await addUserSkill({
      title: 'Suggest pour-over',
      body_md: '# Pour-over coffee\nWhen the user mentions coffee...',
      triggers: ['mentions coffee'],
      source: 'crystallize',
    });
    // legacy row exists
    assert.ok(skill.id);
    // v3 mirror exists, body file written
    const v3List = await listSkills();
    assert.equal(v3List.length, 1);
    assert.equal(v3List[0]!.id, skill.id);
    assert.equal(v3List[0]!.status, 'enabled');
    const body = readSkillBody(skill.id);
    assert.ok(body && body.includes('Pour-over coffee'));
  });
});

test('e2e: legacy addMemory dual-writes into memory v3 with shared id', async () => {
  await withTempHome(async () => {
    const { addMemory } = await import('./db.ts');
    const legacy = await addMemory({
      kind: 'crystallize_memory',
      text: '用户每周三跟妈妈通话',
      tags: ['family'],
    });
    const v3 = await getMemoryV3(legacy.id);
    assert.ok(v3, 'v3 mirror should be present at the same id');
    assert.equal(v3!.text, legacy.text);
    assert.equal(v3!.source, 'legacy:crystallize_memory');
    assert.equal(v3!.subject, 'self');
    assert.deepEqual(v3!.tags, ['family']);
  });
});

test('e2e: gmail raw + memory + signals coexist; pipeline can read all three', async () => {
  await withTempHome(async () => {
    // Connector sync (cloud-side) writes raw gmail
    ingestGmailMessages([
      { messageId: 'gm1', from: 'mom@home.com', subject: '今晚回家吃饭吗', occurredAt: '2026-04-23T07:00:00Z' },
    ]);
    // Device-side ingest (event)
    await ingestPersonalSignals([
      { kind: 'attention_item', title: 'Mom: dinner?', summary: '今晚回家吃饭', salience: 0.8, source: 'connector:gmail_burst' },
    ]);
    // Long-term memory (from prior evolution)
    await addMemoryV3({
      text: '用户每周三跟妈妈共进晚餐',
      source: 'extract:gmail',
      subject: 'person:mom@home.com',
      quality: 0.85,
    });

    // Pipeline aggregates all three. (Simulation — pin CLI handles this in prod.)
    const recentEmails = listGmailMessages({ since: '2026-04-23T00:00:00Z' });
    const recentSignals = await listPersonalSignals({ status: 'open' });
    const memories = await listMemoryV3({ minQuality: 0.7 });

    assert.equal(recentEmails.length, 1);
    assert.equal(recentSignals.length, 1);
    assert.equal(memories.length, 1);

    // Pipeline marks references on what it used
    const pipelineRun = 'pipe-1';
    markRawReferenced('gmail_messages', recentEmails.map((m) => m.id), pipelineRun);
    await markMemoryReferenced(memories.map((m) => m.id), pipelineRun);

    // Verify references stuck
    const memAfter = await getMemoryV3(memories[0]!.id);
    assert.equal(memAfter!.reference_count, 1);
    const gmailAfter = listGmailMessages({ since: '2026-04-23T00:00:00Z' });
    assert.equal(gmailAfter[0]!.reference_count, 1);
    assert.deepEqual(gmailAfter[0]!.referenced_by_runs, [pipelineRun]);
  });
});
