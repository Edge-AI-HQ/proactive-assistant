/**
 * Tests for the Phase B.1 connector evolve agent. The agent call itself
 * is dependency-injected (no real LLM), so we can assert deterministic
 * behavior across happy/empty/malformed/throw paths.
 *
 * What this DOES cover:
 *   - happy path: 3 valid memory writes land in the memory table with
 *     evolution_run delta + refs_produced + markMemoryReferenced
 *   - sampling: 50 input items get capped to MAX_PROMPT_ITEMS in the
 *     user message
 *   - empty input → no agent call, returns 0 writes
 *   - empty agent output (memories: []) → 0 writes, no error
 *   - agent throws → llmFailed=true, error preserved, no memory writes
 *   - parse failure (agent returns gibberish) → llmFailed=true
 *   - sanitization: malformed memory entries (missing text, bad quality,
 *     non-string subject) are silently dropped
 *   - no api + no agentRun → returns immediately with itemsSampled=0,
 *     no error (caller falls back to Phase B v0 behavior)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addMemoryV3,
  createEvolutionRun,
  getEvolutionRun,
  getMemoryV3,
  listMemoryV3,
  resetDbForTests,
  upsertProfile,
} from '../../db.ts';
import { runConnectorEvolve, type AgentRunFn } from './connector-evolve.ts';
import type { GmailMessageInput, GcalEventInput } from '../../raw-db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-conn-evolve-'));
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

function gmailRow(opts: { id: string; from?: string; subject?: string; snippet?: string; ts?: string }): GmailMessageInput {
  return {
    messageId: opts.id,
    from: opts.from ?? 'someone@example.com',
    subject: opts.subject ?? 'subj',
    snippet: opts.snippet ?? '',
    occurredAt: opts.ts ?? new Date().toISOString(),
  };
}

function gcalRow(opts: { id: string; calendarId?: string; title?: string; start?: string }): GcalEventInput {
  return {
    eventId: opts.id,
    calendarId: opts.calendarId ?? 'primary',
    title: opts.title ?? 'meeting',
    startAt: opts.start ?? new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Happy path
// ──────────────────────────────────────────────────────────────────────

test('happy path: 3 valid memories → addMemoryV3 + delta + refs_produced + reference bump', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });

    const agentRun: AgentRunFn = async (_sys, _user) => {
      return '```json\n' + JSON.stringify({
        memories: [
          { text: 'User works on AI safety at Anthropic', subject: 'work:employer', quality: 0.8, confidence: 0.9, tags: ['work'] },
          { text: 'User is interested in PostgreSQL internals', subject: 'topic:postgres', quality: 0.6, confidence: 0.7, tags: ['topic', 'database'] },
          { text: 'Frequent contact: alice@anthropic.com', subject: 'person:alice', quality: 0.7, confidence: 0.8 },
        ],
      }) + '\n```';
    };

    const result = await runConnectorEvolve(
      {
        toolkit: 'gmail',
        evolutionRunId: evo.id,
        gmail: [
          gmailRow({ id: 'm1', subject: 'Code review' }),
          gmailRow({ id: 'm2', subject: 'PR ready' }),
        ],
      },
      { agentRun },
    );

    assert.equal(result.memoriesWritten, 3);
    assert.equal(result.memoryIds.length, 3);
    assert.equal(result.llmFailed, false);
    assert.equal(result.itemsSampled, 2);

    // Memory rows persisted with proper source / sourceRunId
    const rows = await listMemoryV3({ limit: 10 });
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.source, 'connector_init:gmail');
      assert.equal(row.source_run_id, evo.id);
      assert.equal(row.reference_count, 1);
    }

    // Evolution run picks up delta + refs_produced
    const after = await getEvolutionRun(evo.id);
    assert.equal(after!.memories_written, 3);
    assert.deepEqual(after!.refs_produced.memory.sort(), result.memoryIds.sort());
  });
});

test('happy path with profile + recent subjects: agent prompt includes both', async () => {
  await withTempHome(async () => {
    await upsertProfile({ displayName: 'Test', summary: 'Senior engineer interested in distributed systems' });
    await addMemoryV3({ text: 'Existing fact', source: 'manual', subject: 'topic:distributed-systems', quality: 0.7 });

    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    let receivedUserMessage = '';
    const agentRun: AgentRunFn = async (_sys, user) => {
      receivedUserMessage = user;
      return '```json\n{ "memories": [] }\n```';
    };

    await runConnectorEvolve(
      {
        toolkit: 'googlecalendar',
        evolutionRunId: evo.id,
        gcal: [gcalRow({ id: 'e1', title: 'Standup' })],
      },
      { agentRun },
    );

    assert.match(receivedUserMessage, /Senior engineer interested in distributed systems/);
    assert.match(receivedUserMessage, /topic:distributed-systems/);
    assert.match(receivedUserMessage, /Toolkit: googlecalendar/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Sampling
// ──────────────────────────────────────────────────────────────────────

test('sampling: 50 input items are capped to 20 in the prompt', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const items: GmailMessageInput[] = [];
    for (let i = 0; i < 50; i += 1) {
      items.push(gmailRow({
        id: `m${i}`,
        subject: `Item ${i}`,
        ts: new Date(2026, 3, i + 1).toISOString(),
      }));
    }
    let receivedUser = '';
    const agentRun: AgentRunFn = async (_sys, user) => {
      receivedUser = user;
      return '```json\n{ "memories": [] }\n```';
    };
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: items },
      { agentRun },
    );
    assert.equal(result.itemsSampled, 20);
    // Most-recent items appear; the oldest do not
    assert.match(receivedUser, /Item 49/);
    assert.match(receivedUser, /Item 30/);
    assert.equal(receivedUser.includes('Item 0'), false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Empty / no-op paths
// ──────────────────────────────────────────────────────────────────────

test('empty input: no agent call, returns 0 writes', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    let agentCalled = false;
    const agentRun: AgentRunFn = async () => { agentCalled = true; return ''; };
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [] },
      { agentRun },
    );
    assert.equal(result.memoriesWritten, 0);
    assert.equal(agentCalled, false);
    assert.equal(result.llmFailed, false);
    assert.equal(result.itemsSampled, 0);
  });
});

test('empty agent output (memories: []): 0 writes, no error', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const agentRun: AgentRunFn = async () => '```json\n{ "memories": [] }\n```';
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.llmFailed, false);
  });
});

test('no api and no agentRun: returns immediately, no error', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { /* no api, no agentRun */ },
    );
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.itemsSampled, 0);
    assert.equal(result.llmFailed, false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure paths
// ──────────────────────────────────────────────────────────────────────

test('agent throws: llmFailed=true, error preserved, no memory writes', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const agentRun: AgentRunFn = async () => { throw new Error('Subagent timeout after 60s'); };
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.llmFailed, true);
    assert.match(result.llmError ?? '', /Subagent timeout/);
    assert.equal((await listMemoryV3({})).length, 0);
  });
});

test('agent returns gibberish (no JSON): llmFailed=true, no writes', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const agentRun: AgentRunFn = async () => 'I am sorry but I cannot help with that.';
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.llmFailed, true);
    assert.match(result.llmError ?? '', /not parseable/);
  });
});

test('agent returns malformed JSON object (memories not an array): treated as 0 writes', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const agentRun: AgentRunFn = async () => '```json\n{ "memories": "not-an-array" }\n```';
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.llmFailed, false);  // we DID parse, just nothing usable
  });
});

// ──────────────────────────────────────────────────────────────────────
// Sanitization
// ──────────────────────────────────────────────────────────────────────

test('sanitization: malformed entries dropped; valid neighbors preserved', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const agentRun: AgentRunFn = async () => '```json\n' + JSON.stringify({
      memories: [
        { text: 'Valid one', subject: 'topic:x', quality: 0.7, confidence: 0.8 },
        { /* missing text */ subject: 'topic:y', quality: 0.5 },
        { text: '   ', quality: 0.5 },                      // whitespace text
        { text: 'Quality NaN', quality: 'not-a-number' },   // bad quality → defaults
        null,
        { text: 'Subject not a string', subject: 42 },      // bad subject → null
        { text: 'Tags wrong type', tags: 'not-an-array' },  // bad tags → []
      ],
    }) + '\n```';

    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    // 4 valid (Valid one, Quality NaN, Subject not a string, Tags wrong type).
    // Dropped: missing-text, whitespace-only text, null entry.
    assert.equal(result.memoriesWritten, 4);

    const rows = await listMemoryV3({ limit: 10 });
    assert.equal(rows.length, 4);
    const qualityNaN = rows.find((r) => r.text === 'Quality NaN');
    assert.equal(qualityNaN!.quality, 0.5);  // fallback
    const badSubject = rows.find((r) => r.text === 'Subject not a string');
    assert.equal(badSubject!.subject, null); // sanitized away
    const badTags = rows.find((r) => r.text === 'Tags wrong type');
    assert.deepEqual(badTags!.tags, []);
  });
});

test('sanitization: text truncated to 240 chars on write', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const longText = 'x'.repeat(500);
    const agentRun: AgentRunFn = async () => '```json\n' + JSON.stringify({
      memories: [{ text: longText, quality: 0.5 }],
    }) + '\n```';
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    assert.equal(result.memoriesWritten, 1);
    const row = await getMemoryV3(result.memoryIds[0]!);
    assert.ok(row!.text.length <= 240);
  });
});

test('sanitization: clamp out-of-range quality/confidence', async () => {
  await withTempHome(async () => {
    const evo = await createEvolutionRun({ triggerKind: 'on_event' });
    const agentRun: AgentRunFn = async () => '```json\n' + JSON.stringify({
      memories: [
        { text: 'too high', quality: 5, confidence: 99 },
        { text: 'negative', quality: -1, confidence: -0.5 },
      ],
    }) + '\n```';
    const result = await runConnectorEvolve(
      { toolkit: 'gmail', evolutionRunId: evo.id, gmail: [gmailRow({ id: 'm1' })] },
      { agentRun },
    );
    const rows = await listMemoryV3({ limit: 10 });
    const high = rows.find((r) => r.text === 'too high')!;
    const neg = rows.find((r) => r.text === 'negative')!;
    // addMemoryV3 has its own clamp on top of ours; both should be in [0,1]
    assert.ok(high.quality >= 0 && high.quality <= 1);
    assert.ok(neg.quality >= 0 && neg.quality <= 1);
    void result;
  });
});
