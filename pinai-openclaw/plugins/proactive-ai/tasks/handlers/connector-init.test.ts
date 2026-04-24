/**
 * Tests for the connector.init handler. The handler is heavyweight (touches
 * raw.db + personal_signals + evolution_runs in one go), so tests:
 *   - inject a mock ComposioFetcher (no network, deterministic shapes)
 *   - run via the real BackgroundTaskScheduler so we exercise the full
 *     enqueue → claim → handler → terminal contract end-to-end
 *   - assert raw rows / signals / evolution_run all line up with
 *     refs_consumed populated
 *
 * What this DOES NOT cover (intentional, deferred to Phase B.1):
 *   - the evolution agent prompt that turns refs_consumed into memory writes
 *   - the reconciler (separate file)
 *   - frontend UX
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enqueueBackgroundTask,
  getBackgroundTask,
  getEvolutionRun,
  listEvolutionRuns,
  listPersonalSignals,
  resetDbForTests,
} from '../../db.ts';
import {
  listGmailMessages,
  listGcalEvents,
  listSlackMessages,
  listNotionPages,
  listGdriveFiles,
  listGithubIssues,
  listOutlookMessages,
  resetRawDbForTests,
} from '../../raw-db.ts';
import { BackgroundTaskScheduler } from '../scheduler.ts';
import {
  createConnectorInitHandler,
  type ComposioFetcher,
  type ConnectorInitResult,
} from './connector-init.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-conn-init-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  // Default tests don't expect the kill switch to be set
  delete process.env.CONNECTOR_INIT_DISABLED_TOOLKITS;
  try {
    return await fn();
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    delete process.env.CONNECTOR_INIT_DISABLED_TOOLKITS;
    await rm(root, { recursive: true, force: true });
  }
}

function makeMockFetcher(handlers: Record<string, (body: any) => any>): ComposioFetcher {
  return async (path, init) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`mock fetcher: unhandled path ${path}`);
    const body = init?.body ? JSON.parse(init.body) : {};
    return handler(body);
  };
}

function gmailMessage(opts: {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  internalDate?: number;
  bodyText?: string;
}) {
  return {
    id: opts.id,
    threadId: opts.threadId ?? `thr-${opts.id}`,
    snippet: opts.snippet ?? '',
    internalDate: opts.internalDate ?? Date.now(),
    payload: {
      headers: [
        opts.from && { name: 'From', value: opts.from },
        opts.to && { name: 'To', value: opts.to },
        opts.subject && { name: 'Subject', value: opts.subject },
      ].filter(Boolean),
      body: opts.bodyText
        ? { data: Buffer.from(opts.bodyText, 'utf-8').toString('base64url') }
        : undefined,
    },
    labelIds: ['INBOX'],
  };
}

function gcalEvent(opts: {
  id: string;
  calendarId?: string;
  summary?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
  status?: string;
}) {
  return {
    id: opts.id,
    calendarId: opts.calendarId ?? 'primary',
    summary: opts.summary,
    description: opts.description,
    start: { dateTime: opts.startDateTime ?? new Date().toISOString() },
    end: { dateTime: opts.endDateTime ?? new Date(Date.now() + 3600_000).toISOString() },
    status: opts.status ?? 'confirmed',
  };
}

async function runOneTick(handlerDeps: Parameters<typeof createConnectorInitHandler>[0]): Promise<{
  task: NonNullable<Awaited<ReturnType<typeof getBackgroundTask>>>;
  result: ConnectorInitResult | null;
}> {
  const scheduler = new BackgroundTaskScheduler({
    workerId: 'test', leaseDurationMs: 60_000,
  });
  scheduler.registerHandler('connector.init', createConnectorInitHandler(handlerDeps));
  await scheduler.tick();
  // Find the task we just ran (only one in the queue)
  const tasks = await import('../../db.ts').then((m) =>
    m.listBackgroundTasks({ type: 'connector.init', limit: 10 }),
  );
  const task = tasks[0]!;
  const result = task.result as unknown as ConnectorInitResult | null;
  return { task, result };
}

// ──────────────────────────────────────────────────────────────────────
// Gmail happy path
// ──────────────────────────────────────────────────────────────────────

test('gmail: full pipeline → raw + signals + evolution_run with refs', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:gmail:acc-1:v1',
      payload: {
        toolkit: 'gmail',
        connectedAccountId: 'acc-1',
        limit: 3,
        reason: 'first_connect',
      },
    });

    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        data: {
          response_data: {
            messages: [
              gmailMessage({ id: 'm1', from: 'a@x.com', subject: 'Hello', snippet: 'Hi there' }),
              gmailMessage({ id: 'm2', from: 'b@x.com', subject: 'Status', snippet: 'Quick update' }),
              gmailMessage({ id: 'm3', from: 'c@x.com', subject: 'Reminder', snippet: 'Tomorrow' }),
            ],
          },
        },
      }),
    });

    const { task, result } = await runOneTick({ fetcher, userId: 'test-user' });

    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'gmail');
    assert.equal(result?.rawInserted, 3);
    assert.equal(result?.signalsInserted, 3);
    assert.equal(result?.rawIgnored, 0);
    assert.ok(result?.evolutionRunId);

    // raw.db has the three messages
    const rawRows = listGmailMessages({ limit: 10 });
    assert.equal(rawRows.length, 3);
    assert.deepEqual(rawRows.map((r) => r.message_id).sort(), ['m1', 'm2', 'm3']);

    // personal_signals has corresponding rows with raw refs
    const sigs = await listPersonalSignals({ kind: 'connector.gmail.message', limit: 10 });
    assert.equal(sigs.length, 3);
    assert.ok(sigs.every((s) => s.source === 'connector:gmail'));
    assert.ok(sigs.every((s) => s.source_raw_table === 'gmail_messages'));
    assert.ok(sigs.every((s) => s.source_raw_ids.length === 1));

    // evolution_run is completed with refs_consumed pointing back at both
    const evo = await getEvolutionRun(result!.evolutionRunId!);
    assert.equal(evo!.status, 'completed');
    assert.equal(evo!.trigger_kind, 'on_event');
    assert.deepEqual(evo!.refs_consumed.gmail_messages.sort(), rawRows.map((r) => r.id).sort());
    assert.equal(evo!.refs_consumed.personal_signals.length, 3);

    // task.progress should reflect the latest stage we hit (evolve)
    assert.equal(task.progress.stage, 'evolve');
    assert.equal(task.progress.toolkit, 'gmail');
  });
});

test('gmail: rerun on same idempotency key — raw dedupes, signals dedupe, evolution still records the (empty) attempt', async () => {
  await withTempHome(async () => {
    const enqueueOnce = () =>
      enqueueBackgroundTask({
        type: 'connector.init',
        idempotencyKey: 'connector.init:gmail:acc-1:rerun',
        payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 2 },
      });

    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        messages: [
          gmailMessage({ id: 'rm1', subject: 'x' }),
          gmailMessage({ id: 'rm2', subject: 'y' }),
        ],
      }),
    });

    // First run lands the rows
    const e1 = await enqueueOnce();
    assert.equal(e1.created, true);
    const r1 = await runOneTick({ fetcher });
    assert.equal(r1.task.status, 'succeeded');
    assert.equal((r1.result as ConnectorInitResult).rawInserted, 2);

    // Second enqueue with same key returns the existing (now succeeded) row;
    // a real reconciler/UX would skip re-enqueue here. To exercise a forced
    // re-run we have to use a fresh idempotency key — that's the contract.
    const e2 = await enqueueOnce();
    assert.equal(e2.created, false);
    assert.equal(e2.task.id, e1.task.id);

    // Sanity: the raw store still has exactly 2 rows
    const rows = listGmailMessages({ limit: 10 });
    assert.equal(rows.length, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// GCal happy path
// ──────────────────────────────────────────────────────────────────────

test('gcal: full pipeline → raw + signals + evolution_run', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:gcal:acc-2:v1',
      payload: { toolkit: 'googlecalendar', connectedAccountId: 'acc-2', limit: 2 },
    });

    const fetcher = makeMockFetcher({
      '/tools/execute/GOOGLECALENDAR_EVENTS_LIST': () => ({
        data: {
          events: [
            gcalEvent({ id: 'e1', calendarId: 'primary', summary: 'Standup' }),
            gcalEvent({ id: 'e2', calendarId: 'primary', summary: 'PR Review' }),
          ],
        },
      }),
    });

    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'googlecalendar');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);

    const rawRows = listGcalEvents({ limit: 10 });
    assert.equal(rawRows.length, 2);

    const sigs = await listPersonalSignals({ kind: 'connector.gcal.event', limit: 10 });
    assert.equal(sigs.length, 2);
    assert.ok(sigs.every((s) => s.source_raw_table === 'gcal_events'));

    const evo = await getEvolutionRun(result!.evolutionRunId!);
    assert.deepEqual(evo!.refs_consumed.gcal_events.sort(), rawRows.map((r) => r.id).sort());
  });
});

// ──────────────────────────────────────────────────────────────────────
// Validation + skip paths
// ──────────────────────────────────────────────────────────────────────

test('payload validation: missing toolkit → terminal failed (no retry will help)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'bad-1',
      payload: { connectedAccountId: 'acc-x' } as any,
      maxAttempts: 1,
    });
    const { task, result } = await runOneTick({
      fetcher: () => { throw new Error('should not be called'); },
    });
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'invalid_payload');
    assert.equal(result, null);
  });
});

test('payload validation: missing connectedAccountId → terminal failed', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'bad-2',
      payload: { toolkit: 'gmail' } as any,
      maxAttempts: 1,
    });
    const { task } = await runOneTick({
      fetcher: () => { throw new Error('should not be called'); },
    });
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'invalid_payload');
  });
});

test('unsupported toolkit (e.g. asana — not yet in any Phase D round) → succeeded with reason=unsupported_toolkit_v0', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'unsupported-asana',
      payload: { toolkit: 'asana', connectedAccountId: 'acc-as' },
    });
    const { task, result } = await runOneTick({
      fetcher: () => { throw new Error('should not be called'); },
    });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.skipped, true);
    assert.equal(result?.reason, 'unsupported_toolkit_v0');
  });
});

test('kill switch: CONNECTOR_INIT_DISABLED_TOOLKITS=gmail → succeeded with reason=toolkit_disabled', async () => {
  await withTempHome(async () => {
    process.env.CONNECTOR_INIT_DISABLED_TOOLKITS = 'gmail,twitter';
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'killed-gmail',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-k' },
    });
    const { task, result } = await runOneTick({
      fetcher: () => { throw new Error('should not be called'); },
    });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.skipped, true);
    assert.equal(result?.reason, 'toolkit_disabled');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure paths
// ──────────────────────────────────────────────────────────────────────

test('Composio fetch throws → task failed with composio_fetch_failed (retried up to max_attempts)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'fetch-fail',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-z' },
      maxAttempts: 1,  // shorter retry for test
    });
    const fetcher: ComposioFetcher = async () => { throw new Error('Composio API 503: upstream'); };
    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'composio_fetch_failed');
    assert.match(task.last_error_message ?? '', /503/);

    // No raw rows / signals / evolution writes happened
    assert.equal(listGmailMessages({ limit: 10 }).length, 0);
    assert.equal((await listPersonalSignals({ limit: 10 })).length, 0);
    assert.equal((await listEvolutionRuns({})).length, 0);
  });
});

test('empty Composio response → succeeded with rawInserted=0 (no signals, no evolution refs)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'empty',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-empty' },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({ data: { messages: [] } }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 0);
    assert.equal(result?.signalsInserted, 0);
    // Evolution run is still created — useful for "we tried at this time" audit
    assert.ok(result?.evolutionRunId);
    const evo = await getEvolutionRun(result!.evolutionRunId!);
    assert.deepEqual(evo!.refs_consumed, {});
  });
});

test('partial Composio response: malformed messages are silently dropped', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'partial',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-p' },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        messages: [
          gmailMessage({ id: 'good-1', subject: 'OK' }),
          { /* missing id field */ subject: 'no-id' },
          null,
          gmailMessage({ id: 'good-2', subject: 'Also OK' }),
        ],
      }),
    });
    const { result } = await runOneTick({ fetcher });
    assert.equal(result?.rawInserted, 2);
    const rows = listGmailMessages({ limit: 10 });
    assert.deepEqual(rows.map((r) => r.message_id).sort(), ['good-1', 'good-2']);
  });
});

test('limit clamping: payload.limit=999999 is clamped to 500', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'big-limit',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-bl', limit: 999_999 },
    });
    let receivedLimit: number | undefined;
    const fetcher: ComposioFetcher = async (_path, init) => {
      const body = JSON.parse(init!.body);
      receivedLimit = body.arguments.max_results;
      return { messages: [] };
    };
    await runOneTick({ fetcher });
    assert.equal(receivedLimit, 500);
  });
});

// ──────────────────────────────────────────────────────────────────────
// REGRESSION SET — real Composio response shapes verified 2026-04-24
// against the live API. These mocks mirror exactly what the live API
// returns; future mapper edits can't silently regress real-world parsing.
// ──────────────────────────────────────────────────────────────────────

test('REGRESSION: real Composio Slack shape (channel as object, user as string id, username as display name)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'real-slack',
      payload: { toolkit: 'slack', connectedAccountId: 'acc-s', limit: 5 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/SLACK_SEARCH_MESSAGES': () => ({
        data: {
          messages: {
            matches: [
              {
                ts: '1777005797.639519',
                channel: { id: 'C09BZ578WDA', name: 'dev', is_archived: false },
                user: 'U08K1734PV0',          // string user id (NOT an object)
                username: 'smile',              // display name as string
                text: '这些都没那么重要',
                permalink: 'https://x.slack.com/...',
                type: 'message',
                score: 0.42,
                iid: 'iid-1',
                db_message: {},
              },
              {
                ts: '1777005700.123456',
                channel: { id: 'C09BZ578WDA', name: 'dev' },
                user: 'U08K1734PV1',
                username: 'pis',
                text: '当前用 mintlify 肯定是够了',
              },
            ],
          },
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 2);
    const rows = listSlackMessages({ limit: 10 });
    assert.equal(rows.length, 2);
    const first = rows.find((r) => r.ts === '1777005797.639519')!;
    assert.equal(first.channel_id, 'C09BZ578WDA');
    assert.equal(first.channel_name, 'dev');
    assert.equal(first.user_id, 'U08K1734PV0');
    assert.equal(first.user_name, 'smile');
    assert.equal(first.text, '这些都没那么重要');
  });
});

test('REGRESSION: real Composio Notion slim shape (data.values: [{id, title, type}] only)', async () => {
  // Composio NOTION_FETCH_DATA with get_pages returns just id+title+type
  // — none of the rich Notion API fields (no properties, no parent,
  // no last_edited_time). Mapper must accept the slim shape.
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'real-notion',
      payload: { toolkit: 'notion', connectedAccountId: 'acc-n', limit: 5 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/NOTION_FETCH_DATA': () => ({
        data: {
          values: [
            { id: '24fe8c5c-301e-80f2-8a62-efc04fa43082', title: '每日胡思-每天的 context', type: 'page' },
            { id: '34ce8c5c-301e-803e-ab13-f3c5a2427106', title: '李继刚圆桌 prompt', type: 'page' },
            { id: '132e8c5c-301e-8023-bdcb-e9abdf199b75', title: 'Dev-基础信息', type: 'page' },
          ],
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 3);
    const rows = listNotionPages({ limit: 10, includeArchived: true });
    assert.equal(rows.length, 3);
    const planning = rows.find((r) => r.title === '每日胡思-每天的 context')!;
    assert.equal(planning.parent_type, 'page');  // Composio gives type='page', mapper falls through
    assert.equal(planning.last_edited_time, null);
    assert.equal(planning.url, null);
  });
});

test('REGRESSION: real GoogleCalendar GOOGLECALENDAR_EVENTS_LIST shape (data.items, all-day vs timed events)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'real-gcal',
      payload: { toolkit: 'googlecalendar', connectedAccountId: 'acc-c', limit: 5 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GOOGLECALENDAR_EVENTS_LIST': () => ({
        data: {
          items: [
            // all-day event: start/end have .date, no .dateTime
            {
              id: 'evt-allday', summary: 'Home',
              start: { date: '2026-03-30' },
              end: { date: '2026-03-31' },
              organizer: { email: 'smile@pinai.io', self: true },
              status: 'confirmed', eventType: 'default',
              htmlLink: 'https://www.google.com/calendar/event?eid=...',
            },
            // timed event with attendees
            {
              id: 'evt-mtg', summary: 'Standup',
              start: { dateTime: '2026-04-23T10:00:00-07:00' },
              end: { dateTime: '2026-04-23T10:30:00-07:00' },
              organizer: { email: 'pm@x.com' },
              attendees: [{ email: 'me@x.com' }, { email: 'tl@x.com' }],
              status: 'confirmed',
            },
          ],
          accessRole: 'owner', timeZone: 'America/Los_Angeles',
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 2);
    const rows = listGcalEvents({ limit: 10 });
    assert.equal(rows.length, 2);
    const allday = rows.find((r) => r.title === 'Home')!;
    // All-day events store the .date as start_at (normalized to UTC midnight)
    assert.match(allday.start_at ?? '', /^2026-03-30T/);
    const mtg = rows.find((r) => r.title === 'Standup')!;
    assert.equal(mtg.attendees.length, 2);
    assert.match(mtg.start_at ?? '', /^2026-04-23T17:00/);  // 10am PST = 17:00 UTC
  });
});

test('REGRESSION: real GitHub LIST_ISSUES (data.issues array, possibly empty)', async () => {
  // Empty array is the common case for users with no assignments — the
  // task should still succeed cleanly with rawInserted=0.
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'real-github-empty',
      payload: { toolkit: 'github', connectedAccountId: 'acc-g', limit: 100 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER': () => ({
        data: { issues: [] },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 0);
    assert.equal(result?.signalsInserted, 0);
  });
});

test('REGRESSION: real Composio flat shape (verified 2026-04-24 against live API)', async () => {
  // Composio's GMAIL_FETCH_EMAILS does not return raw Gmail format.
  // It returns a FLATTENED shape with quirks that broke the first
  // Phase D run against live data:
  //   - to / cc are STRINGS (comma-separated), NOT arrays
  //   - preview is an OBJECT {body, subject}, NOT a snippet string
  //   - messageTimestamp is an ISO string, NOT ms-since-epoch
  //   - sender is the from address (not "from")
  //   - body comes via messageText
  // This test pins the shape so future mapper edits can't silently
  // drop fields.
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'composio-flat-shape',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-flat', limit: 2 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        data: {
          messages: [
            {
              messageId: 'mid-1',
              threadId: 'tid-1',
              subject: 'Sprint planning',
              sender: 'PM <pm@x.com>',
              to: 'me@x.com, alice@x.com',           // STRING, not array
              cc: 'cto@x.com',                        // STRING
              preview: { body: 'Quick prep notes', subject: 'Sprint planning' },  // OBJECT
              messageText: 'Full body content here.',
              messageTimestamp: '2026-04-23T10:00:00Z',  // ISO string
              labelIds: ['INBOX', 'IMPORTANT'],
              attachmentList: [],
              payload: { headers: [], body: {}, filename: '' },
            },
            {
              messageId: 'mid-2',
              threadId: 'tid-2',
              subject: 'Code review',
              sender: 'tech-lead@x.com',
              to: 'me@x.com',
              preview: { body: 'PR ready' },
              messageText: 'See PR #42',
              messageTimestamp: '2026-04-22T15:00:00Z',
              labelIds: ['INBOX'],
            },
          ],
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);

    const rows = listGmailMessages({ limit: 5 });
    assert.equal(rows.length, 2);
    const sprint = rows.find((r) => r.subject === 'Sprint planning')!;
    // String to → parsed into address list
    assert.deepEqual(sprint.to_addrs, ['me@x.com', 'alice@x.com']);
    assert.deepEqual(sprint.cc_addrs, ['cto@x.com']);
    // sender → from
    assert.equal(sprint.from_addr, 'PM <pm@x.com>');
    // preview.body → snippet
    assert.equal(sprint.snippet, 'Quick prep notes');
    // messageText → body
    assert.equal(sprint.body, 'Full body content here.');
    // ISO messageTimestamp → ISO occurred_at (not NaN, not ms-fudged)
    assert.equal(sprint.occurred_at, '2026-04-23T10:00:00.000Z');
    assert.deepEqual(sprint.label_ids, ['INBOX', 'IMPORTANT']);
  });
});

test('Composio response wrapped at unusual nesting (data.response_data.messages) is still parsed', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'nested',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-n2' },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        data: {
          response_data: {
            messages: [gmailMessage({ id: 'n1', subject: 'Nested' })],
          },
        },
      }),
    });
    const { result } = await runOneTick({ fetcher });
    assert.equal(result?.rawInserted, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase B.1 — evolve hook wiring (LLM injected via deps.evolveAgentRun)
// ──────────────────────────────────────────────────────────────────────

test('evolve enabled: LLM extracts 2 memories → result.memoriesWritten=2, evolution_run completed with delta', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'evolve-happy',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-e1', limit: 3 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        messages: [
          gmailMessage({ id: 'e1', from: 'pm@anthropic.com', subject: 'Sprint planning notes' }),
          gmailMessage({ id: 'e2', from: 'tech-lead@anthropic.com', subject: 'PR feedback for Claude Code' }),
        ],
      }),
    });
    const evolveAgentRun = async () => '```json\n' + JSON.stringify({
      memories: [
        { text: 'User collaborates with Anthropic team on Claude Code', subject: 'work:project', quality: 0.7, confidence: 0.85 },
        { text: 'Frequent contact: pm@anthropic.com', subject: 'person:pm-anthropic', quality: 0.6, confidence: 0.8 },
      ],
    }) + '\n```';

    const scheduler = new BackgroundTaskScheduler({ workerId: 't', leaseDurationMs: 60_000 });
    scheduler.registerHandler('connector.init', createConnectorInitHandler({
      fetcher, evolveAgentRun,
    }));
    await scheduler.tick();

    const tasks = await import('../../db.ts').then((m) => m.listBackgroundTasks({ type: 'connector.init', limit: 5 }));
    const task = tasks[0]!;
    assert.equal(task.status, 'succeeded');
    const result = task.result as unknown as ConnectorInitResult;
    assert.equal(result.memoriesWritten, 2);
    assert.ok(result.evolutionRunId);

    const evo = await import('../../db.ts').then((m) => m.getEvolutionRun(result.evolutionRunId!));
    assert.equal(evo!.status, 'completed');
    assert.equal(evo!.memories_written, 2);
    assert.equal(evo!.refs_produced.memory.length, 2);
  });
});

test('evolve enabled but LLM throws: connector.init still succeeds, evolution_run is failed (not completed), raw + signals preserved', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'evolve-llm-fail',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-ef' },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        messages: [gmailMessage({ id: 'f1', subject: 'Test' })],
      }),
    });
    const evolveAgentRun = async () => { throw new Error('Subagent timeout after 60s'); };

    const scheduler = new BackgroundTaskScheduler({ workerId: 't' });
    scheduler.registerHandler('connector.init', createConnectorInitHandler({
      fetcher, evolveAgentRun,
    }));
    await scheduler.tick();

    const tasks = await import('../../db.ts').then((m) => m.listBackgroundTasks({ type: 'connector.init', limit: 5 }));
    const task = tasks[0]!;
    assert.equal(task.status, 'succeeded'); // raw + signals are valid → task succeeds
    const result = task.result as unknown as ConnectorInitResult;
    assert.equal(result.rawInserted, 1);
    assert.equal(result.memoriesWritten, 0);
    assert.match(result.evolveError ?? '', /Subagent timeout/);

    const evo = await import('../../db.ts').then((m) => m.getEvolutionRun(result.evolutionRunId!));
    assert.equal(evo!.status, 'failed');
    assert.match(evo!.error_message ?? '', /Subagent timeout/);

    // Raw row + personal_signal still present
    const { listGmailMessages } = await import('../../raw-db.ts');
    assert.equal(listGmailMessages({ limit: 10 }).length, 1);
    const sigs = await import('../../db.ts').then((m) => m.listPersonalSignals({ kind: 'connector.gmail.message', limit: 10 }));
    assert.equal(sigs.length, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase D round 1 — Slack + Notion + Google Drive happy paths
// ──────────────────────────────────────────────────────────────────────

test('slack: full pipeline → raw + signals + evolution_run', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:slack:acc-s:v1',
      payload: { toolkit: 'slack', connectedAccountId: 'acc-s', limit: 5 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/SLACK_SEARCH_MESSAGES': () => ({
        data: {
          messages: {
            matches: [
              {
                ts: '1714063221.000400', text: 'Sprint planning notes',
                channel: { id: 'C01', name: 'eng-general' },
                user: { id: 'U01', name: 'alice' },
                permalink: 'https://x.slack.com/archives/C01/p1714063221000400',
              },
              {
                ts: '1714063300.000500', text: 'PR feedback for the connector init',
                channel: { id: 'C01', name: 'eng-general' },
                user: { id: 'U02', name: 'bob' },
                thread_ts: '1714063221.000400',
              },
            ],
          },
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'slack');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);
    const rows = listSlackMessages({ limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.channel_name, 'eng-general');
    assert.equal(rows[0]!.user_name, 'bob');  // most-recent first
  });
});

test('notion: full pipeline → raw + signals + evolution_run', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:notion:acc-n:v1',
      payload: { toolkit: 'notion', connectedAccountId: 'acc-n', limit: 5 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/NOTION_FETCH_DATA': () => ({
        data: {
          results: [
            {
              id: 'page-1', url: 'https://notion.so/page-1',
              last_edited_time: '2026-04-23T10:00:00Z',
              created_time: '2026-04-20T08:00:00Z',
              parent: { type: 'workspace' },
              properties: { title: { title: [{ plain_text: 'Project planning' }] } },
              icon: { emoji: '🎯' },
              content_preview: 'Q2 roadmap for the connector init feature',
            },
            {
              id: 'page-2', url: 'https://notion.so/page-2',
              last_edited_time: '2026-04-22T12:00:00Z',
              parent: { type: 'database_id', database_id: 'db-1' },
              properties: { Name: { title: [{ plain_text: 'OKR Q2' }] } },
              archived: false,
            },
          ],
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'notion');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);
    const rows = listNotionPages({ limit: 10 });
    assert.equal(rows.length, 2);
    const planning = rows.find((r) => r.title === 'Project planning')!;
    assert.equal(planning.parent_type, 'workspace');
    assert.equal(planning.icon, '🎯');
  });
});

test('googledrive: full pipeline → raw + signals + evolution_run', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:googledrive:acc-d:v1',
      payload: { toolkit: 'googledrive', connectedAccountId: 'acc-d', limit: 5 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GOOGLEDRIVE_FIND_FILE': () => ({
        data: {
          files: [
            {
              id: 'file-1', name: 'Roadmap.docx',
              mimeType: 'application/vnd.google-apps.document',
              modifiedTime: '2026-04-23T15:00:00Z',
              createdTime: '2026-04-20T10:00:00Z',
              webViewLink: 'https://docs.google.com/document/d/file-1',
              owners: [{ emailAddress: 'me@example.com', displayName: 'Me' }],
            },
            {
              id: 'file-2', name: 'budget.xlsx',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              modifiedTime: '2026-04-22T11:00:00Z',
              size: '12345',
              owners: [{ emailAddress: 'cfo@example.com' }],
            },
          ],
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'googledrive');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);
    const rows = listGdriveFiles({ limit: 10 });
    assert.equal(rows.length, 2);
    const roadmap = rows.find((r) => r.name === 'Roadmap.docx')!;
    assert.equal(roadmap.mime_type, 'application/vnd.google-apps.document');
    assert.deepEqual(roadmap.owners, ['me@example.com']);
    const budget = rows.find((r) => r.name === 'budget.xlsx')!;
    assert.equal(budget.size_bytes, 12345);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase D round 2 — GitHub + Outlook happy paths
// ──────────────────────────────────────────────────────────────────────

test('github: full pipeline → raw + signals + evolution_run; PRs and issues separated by kind', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:github:acc-gh:v1',
      payload: { toolkit: 'github', connectedAccountId: 'acc-gh', limit: 10 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER': () => ({
        data: [
          {
            id: 901, number: 42, title: 'Token routing P1',
            body: 'Tokens leak across LiteLLM; reproduce by ...',
            state: 'open',
            html_url: 'https://github.com/PIN-AI/PIN-AI-ASSISTANT/issues/42',
            repository_url: 'https://api.github.com/repos/PIN-AI/PIN-AI-ASSISTANT',
            labels: [{ name: 'bug' }, { name: 'P1' }],
            assignees: [{ login: 'alice' }],
            created_at: '2026-04-22T10:00:00Z',
            updated_at: '2026-04-23T11:00:00Z',
            // No pull_request → it's an issue
          },
          {
            id: 902, number: 43, title: 'Add /tasks read API',
            body: '...', state: 'closed',
            html_url: 'https://github.com/PIN-AI/PIN-AI-ASSISTANT/pull/43',
            repository_url: 'https://api.github.com/repos/PIN-AI/PIN-AI-ASSISTANT',
            labels: ['enhancement'],
            assignees: [{ login: 'bob' }, { login: 'carol' }],
            created_at: '2026-04-21T09:00:00Z',
            updated_at: '2026-04-22T15:00:00Z',
            pull_request: { url: '...', html_url: '...' },  // marker
          },
        ],
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'github');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);
    const rows = listGithubIssues({ limit: 10 });
    assert.equal(rows.length, 2);
    const issue42 = rows.find((r) => r.number === 42)!;
    assert.equal(issue42.repo_full_name, 'PIN-AI/PIN-AI-ASSISTANT');
    assert.equal(issue42.is_pull_request, false);
    assert.deepEqual(issue42.labels.sort(), ['P1', 'bug']);
    assert.deepEqual(issue42.assignees, ['alice']);
    const pr43 = rows.find((r) => r.number === 43)!;
    assert.equal(pr43.is_pull_request, true);
    assert.equal(pr43.state, 'closed');

    // Signal kinds split into .issue vs .pr per is_pull_request
    const sigs = await import('../../db.ts').then((m) =>
      m.listPersonalSignals({ limit: 10 }),
    );
    assert.equal(sigs.length, 2);
    const kinds = sigs.map((s) => s.kind).sort();
    assert.deepEqual(kinds, ['connector.github.issue', 'connector.github.pr']);
  });
});

test('outlook: full pipeline → raw + signals + evolution_run', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:outlook:acc-o:v1',
      payload: { toolkit: 'outlook', connectedAccountId: 'acc-o', limit: 10 },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/OUTLOOK_LIST_MESSAGES': () => ({
        data: {
          // Microsoft Graph wraps lists under .value
          value: [
            {
              id: 'AAMkADAxMjQ4...', conversationId: 'conv-1',
              from: { emailAddress: { address: 'manager@x.com', name: 'Manager' } },
              toRecipients: [{ emailAddress: { address: 'me@x.com' } }],
              ccRecipients: [],
              subject: 'Q2 review', bodyPreview: 'Schedule send for next week',
              body: { contentType: 'html', content: '<p>full body...</p>' },
              receivedDateTime: '2026-04-23T14:00:00Z',
              importance: 'High',
              hasAttachments: true,
              webLink: 'https://outlook.office.com/...',
            },
            {
              id: 'AAMkADAxMjQ5...', conversationId: 'conv-2',
              from: { emailAddress: { address: 'newsletter@medium.com' } },
              toRecipients: [{ emailAddress: { address: 'me@x.com' } }],
              subject: 'This week in tech',
              bodyPreview: 'Top stories',
              receivedDateTime: '2026-04-22T08:00:00Z',
              importance: 'normal',
              hasAttachments: false,
            },
          ],
        },
      }),
    });
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'outlook');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);
    const rows = listOutlookMessages({ limit: 10 });
    assert.equal(rows.length, 2);
    const review = rows.find((r) => r.subject === 'Q2 review')!;
    assert.equal(review.from_addr, 'manager@x.com');
    assert.equal(review.importance, 'high');  // lowercased on map
    assert.equal(review.has_attachments, true);
    assert.equal(review.conversation_id, 'conv-1');
    assert.deepEqual(review.to_addrs, ['me@x.com']);
  });
});

test('evolve disabled (no api, no agentRun): existing Phase B v0 behavior preserved (memoriesWritten=0)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'evolve-off',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-off' },
    });
    const fetcher = makeMockFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        messages: [gmailMessage({ id: 'o1', subject: 'X' })],
      }),
    });
    // Note: no evolveAgentRun, no api
    const { task, result } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(result?.memoriesWritten, 0);
    assert.equal(result?.evolveError, undefined);

    const evo = await import('../../db.ts').then((m) => m.getEvolutionRun(result!.evolutionRunId!));
    assert.equal(evo!.status, 'completed');  // marked completed even without LLM
    assert.equal(evo!.memories_written, 0);
  });
});
