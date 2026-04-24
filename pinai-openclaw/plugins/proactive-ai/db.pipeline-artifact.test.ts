/**
 * Tests for pipeline_runs.artifact_path — large iterations JSON is now
 * persisted to data/run-artifacts/<run_id>.json instead of inline DB column.
 * See docs/plans/memory-architecture.mdx §五 (大 JSON 不进 SQLite).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getRunArtifactPath,
  getRunArtifactsDir,
  readRunArtifact,
  resetDbForTests,
  savePipelineRun,
} from './db.ts';

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-pipeline-art-'));
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

test('savePipelineRun: writes iterations payload to artifact file, not DB column', async () => {
  await withTempHome(async (root) => {
    const iterations = [{ iteration: 1, plan: 'x'.repeat(20_000), cards: [] }];
    await savePipelineRun({
      runId: 'run-A',
      status: 'completed',
      totalIterations: 1,
      finalCards: [{ id: 'card-1', title: 'hi' }],
      iterations,
    });

    const expectedPath = join(root, 'data', 'run-artifacts', 'run-A.json');
    assert.equal(getRunArtifactPath('run-A'), expectedPath);
    assert.ok(existsSync(expectedPath), 'artifact file should exist');

    const written = JSON.parse(await readFile(expectedPath, 'utf8'));
    assert.deepEqual(written, iterations);
  });
});

test('readRunArtifact: returns the same payload that was saved', async () => {
  await withTempHome(async () => {
    const iterations = { foo: 'bar', nested: [1, 2, 3] };
    await savePipelineRun({
      runId: 'run-B',
      status: 'completed',
      totalIterations: 1,
      finalCards: [],
      iterations,
    });
    assert.deepEqual(readRunArtifact('run-B'), iterations);
  });
});

test('readRunArtifact: returns null when artifact does not exist', async () => {
  await withTempHome(async () => {
    assert.equal(readRunArtifact('never-saved'), null);
  });
});

test('savePipelineRun: with null iterations does not create artifact file', async () => {
  await withTempHome(async (root) => {
    await savePipelineRun({
      runId: 'run-C',
      status: 'completed',
      totalIterations: 0,
      finalCards: [],
      iterations: null,
    });
    const path = join(root, 'data', 'run-artifacts', 'run-C.json');
    assert.equal(existsSync(path), false);
  });
});

test('getRunArtifactsDir: respects OPENCLAW_HOME', async () => {
  await withTempHome(async (root) => {
    assert.equal(getRunArtifactsDir(), join(root, 'data', 'run-artifacts'));
  });
});

test('savePipelineRun: artifact directory is created on demand', async () => {
  await withTempHome(async (root) => {
    const dir = join(root, 'data', 'run-artifacts');
    assert.equal(existsSync(dir), false);
    await savePipelineRun({
      runId: 'run-D',
      status: 'completed',
      totalIterations: 1,
      finalCards: [],
      iterations: [{ iteration: 1 }],
    });
    const s = await stat(dir);
    assert.ok(s.isDirectory(), 'artifact dir should be auto-created');
  });
});
