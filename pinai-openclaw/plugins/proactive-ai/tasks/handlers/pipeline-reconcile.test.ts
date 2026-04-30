/**
 * pipeline.reconcile handler tests.
 *
 * Covers the long-running poll-loop behavior:
 *   - Polls until validateFinal accepts the session, then finalizes
 *     (regression for prod 2026-04-30 case `run_manual_mokzougs`,
 *     where the agent finished mid-backoff but the old retry loop
 *     waited 10 more minutes before noticing).
 *   - Surfaces subagent error from session messages immediately.
 *   - Honors PIPELINE_RUN_MAX_WAIT_MS, but tries one last poll at the
 *     boundary so an agent that completes during the final sleep still
 *     gets finalized.
 *   - Bails out with failTransient when heartbeat reports lease loss.
 *
 * Subagent runtime is fully mocked. now/sleep are injected so tests
 * don't burn wall-clock seconds.
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

const VALID_FINAL_JSON = JSON.stringify({
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

const PARTIAL_TEXT = '```json\n{\n  "cards": [\n    { "title":'; // unclosed

function fenced(json: string): string {
  return '```json\n' + json + '\n```';
}

interface ApiMock {
  /** Sequence of session-text snapshots. Each call to getSessionMessages
   *  returns the next entry (clamped to the last). undefined → empty session. */
  sessionTexts: Array<string | undefined>;
  /** Optional error injected on the assistant message (last entry). */
  sessionError?: string;
  getSessionCalls: number;
  logs: string[];
}

function makeApi(mock: ApiMock) {
  return {
    logger: {
      info: (m: string) => mock.logs.push(`info:${m}`),
      warn: (m: string) => mock.logs.push(`warn:${m}`),
      error: (m: string) => mock.logs.push(`error:${m}`),
      debug: () => undefined,
    },
    runtime: {
      subagent: {
        run: async () => ({ runId: 'mock-run' }),
        waitForRun: async () => {
          throw new Error('waitForRun should not be called when skipWait=true');
        },
        getSessionMessages: async () => {
          const idx = Math.min(mock.getSessionCalls, mock.sessionTexts.length - 1);
          const text = mock.sessionTexts[idx];
          mock.getSessionCalls += 1;
          if (!text) return { messages: [] };
          const msg: Record<string, unknown> = {
            role: 'assistant',
            content: fenced(text),
          };
          if (mock.sessionError && idx === mock.sessionTexts.length - 1) {
            msg.error = mock.sessionError;
          }
          return { messages: [msg] };
        },
        deleteSession: async () => undefined,
      },
    },
  } as never;
}

interface RunHandlerOpts {
  api: ReturnType<typeof makeApi>;
  /** Heartbeat replies — drained per call; defaults to always-alive. */
  heartbeats?: boolean[];
  /** Synthetic clock; defaults to monotonic +POLL_INTERVAL_MS each tick. */
  now?: () => number;
  /** Capture sleep calls for assertions. */
  sleepCalls?: number[];
}

async function claimAndRun(runId: string, opts: RunHandlerOpts) {
  await enqueueBackgroundTask({
    type: PIPELINE_RECONCILE_TASK_TYPE,
    payload: { pipelineRunId: runId },
    idempotencyKey: pipelineReconcileIdempotencyKey(runId),
    maxAttempts: 2,
  });
  const claim = await claimNextDueBackgroundTask({
    workerId: 'test-worker',
    leaseDurationMs: 60_000,
    types: [PIPELINE_RECONCILE_TASK_TYPE],
  });
  assert.ok(claim, 'expected to claim the just-enqueued task');
  if (!claim) throw new Error('claim returned null');

  const heartbeats = opts.heartbeats ? [...opts.heartbeats] : [];
  const sleepCalls = opts.sleepCalls ?? [];
  const handler = createPipelineReconcileHandler({
    api: opts.api,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    now: opts.now ?? (() => Date.now()),
  });

  return await handler({
    task: claim.task,
    attempt: claim.attempt,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    heartbeat: async () => (heartbeats.length > 0 ? heartbeats.shift()! : true),
  });
}

async function setupRun(runId: string): Promise<void> {
  await savePipelineRunStart({
    runId,
    trigger: 'manual',
    subagentRunId: 'sub-' + runId,
    subagentSessionKey: 'session-' + runId,
  });
}

test('PIPELINE_RUN_MAX_WAIT_MS is the agreed 20 minute cap', () => {
  assert.equal(PIPELINE_RUN_MAX_WAIT_MS, 20 * 60_000);
});

test('pipeline.reconcile: ok on first poll → finalize', async () => {
  await withTempHome(async () => {
    await setupRun('run_first_ok');
    const apiMock: ApiMock = {
      sessionTexts: [VALID_FINAL_JSON],
      getSessionCalls: 0,
      logs: [],
    };
    const result = await claimAndRun('run_first_ok', { api: makeApi(apiMock) });
    assert.equal(result.status, 'succeeded');
    const row = await getPipelineRun('run_first_ok');
    assert.equal(row?.status, 'completed');
    assert.equal(apiMock.getSessionCalls, 1, 'should finalize on the very first poll');
  });
});

test('pipeline.reconcile: partial → partial → complete walks the agent in', async () => {
  await withTempHome(async () => {
    await setupRun('run_walks_in');
    const apiMock: ApiMock = {
      sessionTexts: [PARTIAL_TEXT, PARTIAL_TEXT, VALID_FINAL_JSON],
      getSessionCalls: 0,
      logs: [],
    };
    const sleepCalls: number[] = [];
    const result = await claimAndRun('run_walks_in', { api: makeApi(apiMock), sleepCalls });
    assert.equal(result.status, 'succeeded');
    const row = await getPipelineRun('run_walks_in');
    assert.equal(row?.status, 'completed');
    assert.equal(apiMock.getSessionCalls, 3, 'should poll until validator accepts');
    // Two sleeps: one after each rejected partial. None after the accepting poll.
    assert.equal(sleepCalls.length, 2, 'sleep between polls only, not after success');
  });
});

test('pipeline.reconcile: subagent error in session → markFailed immediately', async () => {
  await withTempHome(async () => {
    await setupRun('run_err');
    const apiMock: ApiMock = {
      sessionTexts: [PARTIAL_TEXT],
      sessionError: 'HTTP 500 internal',
      getSessionCalls: 0,
      logs: [],
    };
    const result = await claimAndRun('run_err', { api: makeApi(apiMock) });
    assert.equal(result.status, 'succeeded');
    const row = await getPipelineRun('run_err');
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /subagent error/i);
  });
});

test('pipeline.reconcile: heartbeat false → bail with lease_lost', async () => {
  await withTempHome(async () => {
    await setupRun('run_lease');
    const apiMock: ApiMock = {
      sessionTexts: [PARTIAL_TEXT, PARTIAL_TEXT, VALID_FINAL_JSON],
      getSessionCalls: 0,
      logs: [],
    };
    const result = await claimAndRun('run_lease', {
      api: makeApi(apiMock),
      heartbeats: [false], // first heartbeat already says lease lost
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'lease_lost');
    assert.equal(apiMock.getSessionCalls, 0, 'must not poll after a dead lease');
  });
});

test('pipeline.reconcile: MAX_WAIT exceeded but last-chance poll succeeds', async () => {
  await withTempHome(async () => {
    await setupRun('run_boundary');
    // Session is unfinished for the regular polls; it appears complete only
    // on the LAST_CHANCE call after the loop exits. Validates that the
    // boundary check actually consults the session.
    const apiMock: ApiMock = {
      sessionTexts: [PARTIAL_TEXT, VALID_FINAL_JSON],
      getSessionCalls: 0,
      logs: [],
    };
    // Synthetic clock: first elapsed() reading inside the loop is 0; the
    // SECOND reading returns past the cap so the loop exits and last-chance
    // runs.
    let nowCalls = 0;
    const startedAtMs = Date.parse(
      (await getPipelineRun('run_boundary'))!.started_at,
    );
    const now = () => {
      nowCalls += 1;
      // Calls: (1) elapsed before first iter (= 0), (2) heartbeat elapsed
      // inside iter 1, (3) sleep happens, (4) elapsed before iter 2 ⇒ blow past cap.
      return nowCalls >= 3
        ? startedAtMs + PIPELINE_RUN_MAX_WAIT_MS + 1
        : startedAtMs;
    };
    const result = await claimAndRun('run_boundary', { api: makeApi(apiMock), now });
    assert.equal(result.status, 'succeeded');
    const row = await getPipelineRun('run_boundary');
    assert.equal(
      row?.status,
      'completed',
      'last-chance read should still finalize a run that completed during the final sleep',
    );
  });
});

test('pipeline.reconcile: MAX_WAIT exceeded + last-chance still partial → max_wait_exceeded', async () => {
  await withTempHome(async () => {
    await setupRun('run_dead');
    const apiMock: ApiMock = {
      sessionTexts: [PARTIAL_TEXT, PARTIAL_TEXT],
      getSessionCalls: 0,
      logs: [],
    };
    let nowCalls = 0;
    const startedAtMs = Date.parse(
      (await getPipelineRun('run_dead'))!.started_at,
    );
    const now = () => {
      nowCalls += 1;
      return nowCalls >= 3
        ? startedAtMs + PIPELINE_RUN_MAX_WAIT_MS + 1
        : startedAtMs;
    };
    const result = await claimAndRun('run_dead', { api: makeApi(apiMock), now });
    assert.equal(result.status, 'succeeded');
    const succeededResult = (result as { result?: Record<string, unknown> }).result ?? {};
    assert.equal(succeededResult.failed, 'max_wait_exceeded');
    const row = await getPipelineRun('run_dead');
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /exceeded max wait/i);
  });
});

test('pipeline.reconcile: missing subagent metadata → markFailed without polling', async () => {
  await withTempHome(async () => {
    // setupRun helper always sets subagent metadata; here we hand-craft a row
    // that mimics a stranded one with missing keys via the same insert path.
    await savePipelineRunStart({
      runId: 'run_no_meta',
      trigger: 'manual',
      subagentRunId: '',
      subagentSessionKey: '',
    });
    const apiMock: ApiMock = {
      sessionTexts: [VALID_FINAL_JSON],
      getSessionCalls: 0,
      logs: [],
    };
    const result = await claimAndRun('run_no_meta', { api: makeApi(apiMock) });
    assert.equal(result.status, 'succeeded');
    assert.equal(apiMock.getSessionCalls, 0, 'no metadata = no point polling');
    const row = await getPipelineRun('run_no_meta');
    assert.equal(row?.status, 'failed');
  });
});
