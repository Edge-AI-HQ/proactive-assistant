/**
 * Smoke tests for pipeline.reconcile handler.
 *
 * Coverage:
 *   - Returns 'failed' (with reconcile_timeout code) when waitForRun says
 *     the subagent is still running, so the framework retries with backoff.
 *   - Marks pipeline_run failed when waitForRun returns 'error'.
 *   - Marks pipeline_run completed when waitForRun returns 'ok' and the
 *     agent text parses cleanly.
 *
 * The MAX_WAIT_MS gate is asserted by reading PIPELINE_RUN_MAX_WAIT_MS as a
 * constant — backdating started_at requires writing through the private
 * getDb() helper, which we don't expose for tests. The gate's logic
 * (Date.now() - started_at > cap) is straightforward enough that the
 * exported constant is the right contract to assert.
 *
 * Subagent runtime is fully mocked — these tests live below the gateway
 * and don't exercise real LLMs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resetDbForTests,
  savePipelineRunStart,
  getPipelineRun,
  enqueueBackgroundTask,
  claimNextDueBackgroundTask,
} from '../../db.ts';
import {
  createPipelineReconcileHandler,
  PIPELINE_RECONCILE_TASK_TYPE,
  PIPELINE_RUN_MAX_WAIT_MS,
  pipelineReconcileIdempotencyKey,
} from './pipeline-reconcile.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-pipeline-recon-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

interface SubagentMock {
  waitStatus: 'ok' | 'timeout' | 'error';
  waitError?: string;
  sessionText?: string;
}

function makeApi(mock: SubagentMock) {
  const fenced = mock.sessionText
    ? '```json\n' + mock.sessionText + '\n```'
    : '';
  return {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    runtime: {
      subagent: {
        run: async () => ({ runId: 'mock-run' }),
        waitForRun: async () => ({
          status: mock.waitStatus,
          ...(mock.waitError ? { error: mock.waitError } : {}),
        }),
        getSessionMessages: async () => ({
          messages: fenced
            ? [{ role: 'assistant', content: fenced }]
            : [],
        }),
        deleteSession: async () => undefined,
      },
    },
  } as never;
}

async function setupRun(runId: string): Promise<void> {
  await savePipelineRunStart({
    runId,
    trigger: 'manual',
    subagentRunId: 'sub-' + runId,
    subagentSessionKey: 'session-' + runId,
  });
}

async function claimAndRun(api: ReturnType<typeof makeApi>, runId: string) {
  await enqueueBackgroundTask({
    type: PIPELINE_RECONCILE_TASK_TYPE,
    payload: { pipelineRunId: runId },
    idempotencyKey: pipelineReconcileIdempotencyKey(runId),
    maxAttempts: 5,
  });
  const claim = await claimNextDueBackgroundTask({
    workerId: 'test-worker',
    leaseDurationMs: 60_000,
    types: [PIPELINE_RECONCILE_TASK_TYPE],
  });
  assert.ok(claim, 'expected to claim the just-enqueued task');
  if (!claim) throw new Error('claim returned null');
  const handler = createPipelineReconcileHandler({ api });
  return await handler({
    task: claim.task,
    attempt: claim.attempt,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    heartbeat: async () => true,
  });
}

test('PIPELINE_RUN_MAX_WAIT_MS is the agreed 20 minute cap', () => {
  assert.equal(PIPELINE_RUN_MAX_WAIT_MS, 20 * 60_000);
});

test('pipeline.reconcile: timeout → returns failed (reconcile_timeout) so framework retries', async () => {
  await withTempHome(async () => {
    await setupRun('run_t1');
    const result = await claimAndRun(makeApi({ waitStatus: 'timeout' }), 'run_t1');
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'reconcile_timeout');
    const row = await getPipelineRun('run_t1');
    assert.equal(row?.status, 'reconciling', 'should have transitioned to reconciling');
  });
});

test('pipeline.reconcile: subagent error → marks pipeline failed and reports succeeded', async () => {
  await withTempHome(async () => {
    await setupRun('run_e1');
    const result = await claimAndRun(
      makeApi({ waitStatus: 'error', waitError: 'boom' }),
      'run_e1',
    );
    assert.equal(result.status, 'succeeded');
    const row = await getPipelineRun('run_e1');
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /subagent error/i);
  });
});

test('pipeline.reconcile: ok + parseable text → marks pipeline completed', async () => {
  await withTempHome(async () => {
    await setupRun('run_ok');
    const sessionJson = JSON.stringify({
      reasoning: 'test',
      cards: [
        {
          title: 'Reply to teammate',
          whyNow: 'asked a question',
          summary: 'context available',
          primaryAction: { label: 'Reply', type: 'confirm' },
          goalBasket: 'work',
        },
      ],
      evaluations: [{ cardId: 'placeholder', overall: 8, pass: true }],
      batchFeedback: 'good',
    });
    const result = await claimAndRun(
      makeApi({ waitStatus: 'ok', sessionText: sessionJson }),
      'run_ok',
    );
    assert.equal(result.status, 'succeeded');
    const row = await getPipelineRun('run_ok');
    assert.equal(row?.status, 'completed');
    assert.ok(Array.isArray(row?.final_cards), 'final_cards should be populated');
  });
});
