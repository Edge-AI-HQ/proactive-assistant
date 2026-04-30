/**
 * Regression tests for the teammate code-review batch:
 * - P1: garbage numeric flags must return VALIDATION, not throw RangeError
 * - P1: device-contacts search must filter in SQL (not after LIMIT)
 * - P2: gcal ingest must normalize start_at to UTC; today/week must honor --timezone
 * - P2: memory add must fail loud on invalid --quality / --confidence
 * - P2: memory search must find matches beyond the previous 500-row prefetch
 * - P3: device-contacts `search` requires --query (else it silently lists all)
 *
 * See docs/plans/memory-architecture.mdx §五 / §六.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { handleEvolution } from './evolution.ts';
import { handleFeedback } from './feedback.ts';
import { handleMemory } from './memory.ts';
import { handlePersonal } from './personal.ts';
import { handleProfile } from './profile.ts';
import { handleSignals } from './signals.ts';
import { handleRaw } from './raw.ts';
import { handleSys } from './sys.ts';
import { handleSkills } from './skills.ts';
import { handleWorld } from './world.ts';
import { PUBLIC_CLI_SCHEMA } from './public-surface.ts';

import {
  addMemoryV3,
  resetDbForTests,
} from '../db.ts';
import {
  ingestDeviceContactsSnapshot,
  ingestGcalEvents,
  listGcalEvents,
  resetRawDbForTests,
} from '../raw-db.ts';

const execFileAsync = promisify(execFile);

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-v3-review-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  try {
    return await fn(root);
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function decode(raw: string): { ok: boolean; data: any; error: any } {
  return JSON.parse(raw);
}

// ─── P1 #1 — numeric validation on --hours / --limit ───────────────────

test('pin signals recent --hours abc: returns VALIDATION, does not throw', async () => {
  await withTempHome(async () => {
    const r = decode(await handleSignals(['recent', '--hours', 'abc']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('hours'));
  });
});

test('pin signals recent --limit NaN: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleSignals(['recent', '--limit', 'not-a-number']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin raw gmail recent --hours garbage: returns VALIDATION, not RangeError', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['gmail', 'recent', '--hours', 'junk']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin raw device-apps --top abc: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['device-apps', '--top', 'abc']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin evolution recent --limit abc: returns VALIDATION, not INTERNAL', async () => {
  await withTempHome(async () => {
    const r = decode(await handleEvolution(['recent', '--limit', 'abc']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('limit'));
  });
});

// ─── P1 #2 — device-contacts search must filter in SQL, then LIMIT ─────

test('pin raw device-contacts search finds match beyond default LIMIT', async () => {
  await withTempHome(async () => {
    // Build 300 contacts sorted by display_name; plant the needle at
    // position 280 so a pre-LIMIT-200 path would miss it.
    const contacts = [] as Array<{ displayName: string; emails?: string[] }>;
    for (let i = 0; i < 300; i++) {
      contacts.push({ displayName: `User ${String(i).padStart(3, '0')}` });
    }
    // Replace one entry near the end with a unique pattern we can search for.
    contacts[280] = { displayName: 'User 280 UNIQUEPATTERN_ZZZ' };
    ingestDeviceContactsSnapshot({ deviceId: 'dev-long', contacts });

    const r = decode(await handleRaw([
      'device-contacts', 'search', '--query', 'UNIQUEPATTERN_ZZZ',
      '--deviceId', 'dev-long', '--limit', '50',
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1, 'search must find the row even when it sorts beyond LIMIT rows');
    assert.ok(r.data.contacts[0].display_name.includes('UNIQUEPATTERN_ZZZ'));
  });
});

test('pin raw device-contacts search is case-insensitive on email substrings', async () => {
  await withTempHome(async () => {
    ingestDeviceContactsSnapshot({
      deviceId: 'd',
      contacts: [
        { displayName: 'Alice', emails: ['Alice.Chen@Example.COM'] },
        { displayName: 'Bob', emails: ['bob@other.com'] },
      ],
    });
    const r = decode(await handleRaw([
      'device-contacts', 'search', '--query', 'alice.chen', '--deviceId', 'd',
    ]));
    assert.equal(r.data.count, 1);
  });
});

// ─── P2 #3 — gcal ingest normalizes start_at; today/week honor --timezone ──

test('gcal ingest normalizes start_at from +08:00 offset to UTC Z', async () => {
  await withTempHome(async () => {
    ingestGcalEvents([
      { calendarId: 'cal1', eventId: 'e-sh',
        startAt: '2026-04-23T08:30:00+08:00', endAt: '2026-04-23T09:30:00+08:00', title: 'SH morning' },
      { calendarId: 'cal1', eventId: 'e-utc',
        startAt: '2026-04-23T00:30:00Z', endAt: '2026-04-23T01:30:00Z', title: 'UTC match' },
    ]);
    const rows = listGcalEvents();
    const sh = rows.find((r) => r.event_id === 'e-sh')!;
    const utc = rows.find((r) => r.event_id === 'e-utc')!;
    assert.equal(sh.start_at, '2026-04-23T00:30:00.000Z', 'Shanghai 08:30+08:00 should be UTC 00:30Z');
    assert.ok(utc.start_at!.endsWith('Z'));
  });
});

test('gcal listGcalEvents with mixed-offset since bound now works', async () => {
  await withTempHome(async () => {
    ingestGcalEvents([
      { calendarId: 'c', eventId: 'a', startAt: '2026-04-23T08:30:00+08:00' },   // = 00:30 Z
      { calendarId: 'c', eventId: 'b', startAt: '2026-04-23T16:00:00+08:00' },   // = 08:00 Z
    ]);
    // Caller passes a non-UTC bound — after normalization this must match event a.
    const rows = listGcalEvents({ since: '2026-04-23T08:00:00+08:00', until: '2026-04-23T12:00:00+08:00' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_id, 'a');
  });
});

test('pin raw gcal today --timezone Asia/Shanghai reports the SH day window', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['gcal', 'today', '--timezone', 'Asia/Shanghai']));
    assert.equal(r.ok, true);
    assert.equal(r.data.timezone, 'Asia/Shanghai');
    // Window should be exactly 24h wide, both bounds UTC ISO, and the
    // `since` should be UTC midnight relative to Shanghai (i.e. ending in
    // ":00:00.000Z" at either 16:00Z previous day or 00:00Z depending on
    // when the test runs). Just assert shape + width here.
    const since = new Date(r.data.since);
    const until = new Date(r.data.until);
    const widthMs = until.getTime() - since.getTime();
    assert.equal(widthMs, 24 * 3600 * 1000);
    assert.ok(/\.000Z$/.test(r.data.since));
  });
});

test('pin raw gcal week --timezone has a 7-day window', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['gcal', 'week', '--timezone', 'America/Los_Angeles']));
    assert.equal(r.ok, true);
    const widthMs = new Date(r.data.until).getTime() - new Date(r.data.since).getTime();
    assert.equal(widthMs, 7 * 24 * 3600 * 1000);
  });
});

// ─── P2 #4 — memory add fails loud on invalid --quality / --confidence ──

test('pin memory add --quality abc: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleMemory([
      'add', '--text', 'x', '--source', 'manual', '--quality', 'abc',
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('quality'));
  });
});

test('pin memory add --confidence garbage: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleMemory([
      'add', '--text', 'x', '--source', 'manual', '--confidence', 'garbage',
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

// ─── P2 #5 — memory search must find matches beyond the old 500 prefetch ──

test('pin memory search: finds row ranked far past 500 when sorted by quality', async () => {
  await withTempHome(async () => {
    // Seed >500 low-quality noise + one high-quality control + the needle.
    for (let i = 0; i < 510; i++) {
      await addMemoryV3({
        text: `noise ${i} lorem ipsum`,
        source: 'manual',
        subject: 'self',
        quality: 0.8,                       // noise dominates the top-N window
      });
    }
    await addMemoryV3({
      text: 'NEEDLE_TEXT_ZZZ — a very specific phrase',
      source: 'manual',
      subject: 'self',
      quality: 0.1,                         // low quality → would be ranked last
    });
    const r = decode(await handleMemory(['search', '--query', 'NEEDLE_TEXT_ZZZ', '--limit', '5']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1, 'search must find the needle even when ranked past 500');
    assert.ok(r.data.memories[0].text.includes('NEEDLE_TEXT_ZZZ'));
  });
});

// ─── P3 #6 — device-contacts search requires --query ───────────────────

test('pin raw device-contacts search (no --query): returns VALIDATION', async () => {
  await withTempHome(async () => {
    ingestDeviceContactsSnapshot({
      deviceId: 'd', contacts: [{ displayName: 'A' }],
    });
    const r = decode(await handleRaw(['device-contacts', 'search', '--deviceId', 'd']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('query'));
  });
});

test('pin raw device-contacts list (no --query) still lists the full snapshot', async () => {
  await withTempHome(async () => {
    ingestDeviceContactsSnapshot({
      deviceId: 'd', contacts: [{ displayName: 'A' }, { displayName: 'B' }],
    });
    const r = decode(await handleRaw(['device-contacts', 'list', '--deviceId', 'd']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 2);
  });
});

test('pin sys schema exposes only the public PCI surface', async () => {
  const r = decode(await handleSys(['schema']));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.domains, PUBLIC_CLI_SCHEMA);
  assert.deepEqual(Object.keys(r.data.domains).sort(), [
    'cards', 'feedback', 'memory', 'personal', 'profile', 'raw', 'signals', 'sys', 'world',
  ].sort());
  assert.deepEqual(r.data.domains.profile, ['get', 'snapshot']);
  assert.deepEqual(r.data.domains.memory, ['list', 'get', 'search']);
  assert.deepEqual(r.data.domains.signals, ['recent', 'list', 'get']);
  assert.deepEqual(r.data.domains.feedback, ['list', 'get', 'stats']);
  assert.deepEqual(r.data.domains.cards, ['recent']);
  assert.deepEqual(r.data.domains.personal, [
    'status', 'connections list', 'connect', 'wait', 'tools search', 'tools schema', 'exec',
  ]);
  assert.deepEqual(r.data.domains.sys, ['schema']);
  assert.equal(r.data.domains.raw.includes('device-health list'), true);
  assert.equal(r.data.domains.world.includes('index'), false);
  assert.equal(
    r.data.domains.personal.some((cmd: string) => cmd.startsWith('mobile')),
    false,
  );
  assert.equal('skills' in r.data.domains, false);
  assert.equal('tasks' in r.data.domains, false);
  assert.equal('evolution' in r.data.domains, false);
  assert.equal('push' in r.data.domains, false);
});

test('pin sys doctor uses the same Composio key resolution as personal commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pin-v3-review-key-'));
  const keyPath = join(root, 'composio-api-key');
  const previousFile = process.env.COMPOSIO_API_KEY_FILE;
  const previousEnv = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY_FILE = keyPath;
  delete process.env.COMPOSIO_API_KEY;
  try {
    await import('node:fs/promises').then((fs) => fs.writeFile(keyPath, 'ak_file_test\n'));
    const r = decode(await handleSys(['doctor']));
    const composio = r.data.checks.find((check: any) => check.name === 'composio');
    assert.equal(composio.status, 'ok');
    assert.match(composio.message, /user key file/);
  } finally {
    if (previousFile === undefined) delete process.env.COMPOSIO_API_KEY_FILE;
    else process.env.COMPOSIO_API_KEY_FILE = previousFile;
    if (previousEnv === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test('pin exits non-zero for failure envelopes', async () => {
  await withTempHome(async (root) => {
    const binPath = join(__dirname, 'bin.ts');
    await assert.rejects(
      execFileAsync('npx', ['tsx', binPath, 'memory', 'get'], {
        env: { ...process.env, OPENCLAW_HOME: root },
      }),
      (err: any) => {
        assert.equal(err.code, 1);
        const r = decode(err.stdout);
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'VALIDATION');
        return true;
      },
    );
  });
});

test('pin public dispatcher hides and rejects internal commands by default', async () => {
  await withTempHome(async (root) => {
    const binPath = join(__dirname, 'bin.ts');
    const publicEnv = { ...process.env, OPENCLAW_HOME: root };
    delete publicEnv.PIN_CLI_SURFACE;
    delete publicEnv.PIN_CLI_INTERNAL;

    const help = await execFileAsync('npx', ['tsx', binPath, '--help'], { env: publicEnv });
    const helpEnvelope = decode(help.stdout);
    assert.deepEqual(helpEnvelope.data.domains.sort(), [
      'cards', 'feedback', 'memory', 'personal', 'profile', 'raw', 'signals', 'sys', 'world',
    ].sort());

    await assert.rejects(
      execFileAsync('npx', ['tsx', binPath, 'tasks', 'list', '--limit', '1'], { env: publicEnv }),
      (err: any) => {
        assert.equal(err.code, 1);
        const r = decode(err.stdout);
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'FORBIDDEN');
        assert.equal(r.error.message.includes('--limit'), false);
        assert.equal(r.error.message.includes(' 1 '), false);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync('npx', ['tsx', binPath, 'unknown'], { env: publicEnv }),
      (err: any) => {
        assert.equal(err.code, 1);
        const r = decode(err.stdout);
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'NOT_FOUND');
        assert.doesNotMatch(r.error.hint, /tasks|skills|evolution/);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync('npx', ['tsx', binPath, 'memory', 'add', '--text', '__pci_public_probe__'], { env: publicEnv }),
      (err: any) => {
        assert.equal(err.code, 1);
        const r = decode(err.stdout);
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'FORBIDDEN');
        return true;
      },
    );

    const memories = decode(await handleMemory(['list', '--status', 'active', '--limit', '10']));
    assert.equal(memories.data.memories.some((m: any) => m.text === '__pci_public_probe__'), false);
  });
});

test('pin internal dispatcher is opt-in for admin commands', async () => {
  await withTempHome(async (root) => {
    const binPath = join(__dirname, 'bin.ts');
    const internalEnv = { ...process.env, OPENCLAW_HOME: root, PIN_CLI_SURFACE: 'internal' };
    const help = await execFileAsync('npx', ['tsx', binPath, '--help'], { env: internalEnv });
    const helpEnvelope = decode(help.stdout);
    assert.ok(helpEnvelope.data.domains.includes('tasks'));
    assert.ok(helpEnvelope.data.domains.includes('skills'));
    assert.ok(helpEnvelope.data.domains.includes('evolution'));
  });
});

test('legacy pin list commands reject invalid --limit values', async () => {
  await withTempHome(async () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ['world.search', () => handleWorld(['search', '--query', 'x', '--limit', 'abc'])],
      ['world.headlines', () => handleWorld(['headlines', '--limit', 'abc'])],
      ['world.find', () => handleWorld(['find', '--query', 'x', '--limit', 'abc'])],
      ['world.shortlist', () => handleWorld(['shortlist', '--limit', 'abc'])],
      ['skills.list', () => handleSkills(['list', '--limit', 'abc'])],
      ['feedback.list', () => handleFeedback(['list', '--limit', 'abc'])],
      ['profile.memory.list', () => handleProfile(['memory', 'list', '--limit', 'abc'])],
      ['profile.memory.search', () => handleProfile(['memory', 'search', '--query', 'x', '--limit', 'abc'])],
      ['profile.interests.list', () => handleProfile(['interests', 'list', '--limit', 'abc'])],
    ];
    for (const [name, run] of cases) {
      const r = decode(await run());
      assert.equal(r.ok, false, name);
      assert.equal(r.error.code, 'VALIDATION', name);
      assert.match(r.error.message, /limit/i, name);
    }
  });
});

test('pin JSON flags return VALIDATION on malformed JSON', async () => {
  await withTempHome(async () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ['feedback.log', () => handleFeedback(['log', '--kind', 'test', '--metadata', '{bad'])],
      ['profile.update', () => handleProfile(['update', '--metadata', '{bad'])],
      ['profile.facts.set', () => handleProfile(['facts', 'set', '--key', 'k', '--value-json', '{bad'])],
      ['profile.preferences.set', () => handleProfile(['preferences', 'set', '--key', 'k', '--value-json', '{bad'])],
      ['profile.constraints.set', () => handleProfile(['constraints', 'set', '--key', 'k', '--value-json', '{bad'])],
      ['profile.memory.add', () => handleProfile(['memory', 'add', '--kind', 'note', '--text', 'hi', '--tags-json', '{bad'])],
    ];
    for (const [name, run] of cases) {
      const r = decode(await run());
      assert.equal(r.ok, false, name);
      assert.equal(r.error.code, 'VALIDATION', name);
      assert.match(r.error.message, /json/i, name);
    }
  });
});

test('pin personal direct tool commands call Composio tools APIs', async () => {
  const previousKey = process.env.COMPOSIO_API_KEY;
  const previousUserId = process.env.COMPOSIO_USER_ID;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  process.env.COMPOSIO_API_KEY = 'ak_test';
  process.env.COMPOSIO_USER_ID = 'user_test';
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.includes('/tools?')) {
      return new Response(JSON.stringify({
        items: [{ slug: 'GMAIL_FETCH_EMAILS', description: 'Fetch Gmail emails', toolkit: { slug: 'gmail' } }],
      }), { status: 200 });
    }
    if (url.includes('/tools/GMAIL_FETCH_EMAILS')) {
      return new Response(JSON.stringify({
        slug: 'GMAIL_FETCH_EMAILS',
        input_parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }), { status: 200 });
    }
    if (url.includes('/tools/execute/GMAIL_FETCH_EMAILS')) {
      return new Response(JSON.stringify({ data: { messages: [{ id: 'm1' }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 500 });
  };
  try {
    const search = decode(await handlePersonal(['tools', 'search', '--query', 'gmail']));
    assert.equal(search.ok, true);
    assert.equal(search.data.tools[0].slug, 'GMAIL_FETCH_EMAILS');

    const schema = decode(await handlePersonal(['tools', 'schema', '--tool', 'GMAIL_FETCH_EMAILS']));
    assert.equal(schema.ok, true);
    assert.deepEqual(schema.data.parameters.properties.query, { type: 'string' });

    const exec = decode(await handlePersonal([
      'exec', '--tool', 'GMAIL_FETCH_EMAILS', '--input', '{"query":"after:1776960000"}',
    ]));
    assert.equal(exec.ok, true);
    assert.deepEqual(calls.at(-1)?.body, {
      user_id: 'user_test',
      arguments: { query: 'after:1776960000' },
    });
    assert.deepEqual(exec.data.result.data.messages, [{ id: 'm1' }]);
  } finally {
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    if (previousUserId === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = previousUserId;
    globalThis.fetch = previousFetch;
  }
});

test('pin personal tool provider errors stringify object payloads', async () => {
  const previousKey = process.env.COMPOSIO_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.COMPOSIO_API_KEY = 'ak_test';
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { reason: 'bad_user', detail: 'No connected account' },
  }), { status: 400 });
  try {
    await assert.rejects(
      handlePersonal(['exec', '--tool', 'GMAIL_FETCH_EMAILS', '--input', '{}']),
      /bad_user/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test('pin personal exec rejects side-effect tool slugs before provider call', async () => {
  const previousKey = process.env.COMPOSIO_API_KEY;
  const previousUserId = process.env.COMPOSIO_USER_ID;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.COMPOSIO_API_KEY = 'ak_test';
  process.env.COMPOSIO_USER_ID = 'user_test';
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const r = decode(await handlePersonal(['exec', '--tool', 'GMAIL_SEND_EMAIL', '--input', '{}']));
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'validation');
    assert.match(r.error.message, /side effect/i);
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    if (previousUserId === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = previousUserId;
    globalThis.fetch = previousFetch;
  }
});

test('pin personal exec allows only explicit side-effect tool allowlist with flag', async () => {
  const previousKey = process.env.COMPOSIO_API_KEY;
  const previousUserId = process.env.COMPOSIO_USER_ID;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.COMPOSIO_API_KEY = 'ak_test';
  process.env.COMPOSIO_USER_ID = 'user_test';
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls++;
    return new Response(JSON.stringify({
      ok: true,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }), { status: 200 });
  };
  try {
    const denied = decode(await handlePersonal([
      'exec', '--tool', 'GMAIL_SEND_EMAIL', '--input', '{"to":"smiletoye@gmail.com"}',
      '--allow-side-effect', 'true',
    ]));
    assert.equal(denied.ok, false);
    assert.equal(denied.error.type, 'validation');
    assert.equal(fetchCalls, 0);

    const r = decode(await handlePersonal([
      'exec', '--tool', 'GMAIL_CREATE_EMAIL_DRAFT', '--input', '{"recipient_email":"smiletoye@gmail.com"}',
      '--allow-side-effect', 'true',
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.data.sideEffectAllowed, true);
    assert.equal(fetchCalls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    if (previousUserId === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = previousUserId;
    globalThis.fetch = previousFetch;
  }
});

test('legacy pin numeric flags reject non-finite values', async () => {
  await withTempHome(async () => {
    const run = decode(await handleEvolution(['create', '--triggerKind', 'manual']));
    assert.equal(run.ok, true);
    const runId = run.data.run.id;

    // Phase 2c retired `pin profile signal rollup` (no v3 equivalent),
    // so it now returns REMOVED instead of VALIDATION. Verified separately
    // below; the validation cases stay focused on the live commands.
    const cases: Array<[string, () => Promise<string>, RegExp]> = [
      ['profile.signal.add', () => handleProfile([
        'signal', 'add', '--kind', 'k', '--target-type', 'topic', '--target-key', 'x', '--value', 'abc',
      ]), /value/i],
      ['evolution.delta', () => handleEvolution(['delta', '--id', runId, '--memoriesWritten', 'abc']), /memoriesWritten/i],
      ['evolution.complete.llmTokens', () => handleEvolution(['complete', '--id', runId, '--llmTokens', 'abc']), /llmTokens/i],
    ];
    for (const [name, run, pattern] of cases) {
      const r = decode(await run());
      assert.equal(r.ok, false, name);
      assert.equal(r.error.code, 'VALIDATION', name);
      assert.match(r.error.message, pattern, name);
    }

    // Retired commands return a clearly-coded REMOVED failure.
    const removed = decode(await handleProfile(['signal', 'rollup']));
    assert.equal(removed.ok, false);
    assert.equal(removed.error.code, 'REMOVED');
    assert.match(removed.error.message, /retired in Phase 2c/);
  });
});
