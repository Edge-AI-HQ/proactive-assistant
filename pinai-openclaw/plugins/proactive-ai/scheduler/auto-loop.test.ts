import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runAutoCardChatFeedback, runAutoDreaming, runAutoCrystallize, runDetectAndLoop } from "./auto-loop.ts";
import {
  bumpCrystallizeTurn,
  listPipelineRuns,
  listEvolutionRuns,
  resetDbForTests,
  updateUserSettings,
  upsertProfile,
} from "../db.ts";
import { resetRawDbForTests } from "../raw-db.ts";
import { listDreamRuns } from "../dreaming/service.ts";
import { resetStoreForTests as resetDreamStoreForTests } from "../dreaming/store.ts";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pin-auto-loop-"));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  resetDreamStoreForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    resetDreamStoreForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const SYNTHESIS = {
  summary: { kind: "updated", text: "auto-loop test", highlights: [] },
  candidateCards: [],
  journalMarkdown: "# auto-loop\nA dream from the auto-loop tick.",
  interestTopics: [],
  goalDelta: { changes: [] },
};

function makeApi(synthesis: Record<string, unknown> = SYNTHESIS) {
  const fenced = "```json\n" + JSON.stringify(synthesis) + "\n```";
  return {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    runtime: {
      subagent: {
        run: async () => ({ runId: `run-${Date.now()}` }),
        waitForRun: async () => ({ status: "ok" as const }),
        getSessionMessages: async () => ({ messages: [{ role: "assistant", content: fenced }] }),
        deleteSession: async () => undefined,
      },
      events: { onAgentEvent: () => () => undefined },
    },
  } as never;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// ── runAutoCardChatFeedback (existing tests) ─────────────────────────────

test("runAutoCardChatFeedback syncs when pipeline is idle", async () => {
  const calls: string[] = [];
  await runAutoCardChatFeedback(
    { logger: { error: () => undefined } } as never,
    { running: false, phase: null, iteration: null },
    {
      syncCardChatFeedback: async () => { calls.push("sync"); },
    },
  );
  assert.deepEqual(calls, ["sync"]);
});

test("runAutoCardChatFeedback skips sync while pipeline is running", async () => {
  let called = false;
  await runAutoCardChatFeedback(
    { logger: { error: () => undefined } } as never,
    { running: true, phase: "manual", iteration: 1 },
    {
      syncCardChatFeedback: async () => { called = true; },
    },
  );
  assert.equal(called, false);
});

test("runDetectAndLoop: does not save a pipeline run twice", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_generate: true });
    const generatorOutput = {
      reasoning: "auto generate test",
      cards: [{
        title: "Reply to teammate",
        whyNow: "A teammate asked a direct question today.",
        summary: "The user can answer with existing context.",
        primaryAction: { label: "Reply" },
        goalBasket: "work",
      }],
      evaluations: [{ cardId: "draft-1", overall: 8, pass: true }],
      iterationFeedback: "keep",
    };

    await runDetectAndLoop(
      makeApi(generatorOutput),
      {
        auto_ingest_interval_ms: 300_000,
        auto_detect_interval_ms: 60_000,
        auto_loop_min_interval_ms: 0,
        max_iterations: 1,
        cards_per_iteration: 1,
        agent_timeout_ms: 1000,
      },
      { running: false, phase: null, iteration: null },
    );

    const runs = await listPipelineRuns({ limit: 5 });
    assert.equal(runs.length, 1);
  });
});

// ── runAutoDreaming ──────────────────────────────────────────────────────
//
// Background path: the auto-loop tick fires runAutoDreaming once a minute.
// It must respect the auto_dreaming user setting AND the daily-due window
// before kicking off a real dream. These tests verify both gates work.

test("runAutoDreaming: skipped when auto_dreaming setting is off", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_dreaming: false });
    await upsertProfile({ displayName: "T", locale: "en", timezone: "UTC" });

    await runAutoDreaming(makeApi());

    // No dream_run row should have been created.
    const runs = await listDreamRuns();
    assert.equal(runs.length, 0);
    // No evolution_run mirror either.
    const evol = await listEvolutionRuns({ triggerKind: "daily_dream", limit: 5 });
    assert.equal(evol.length, 0);
  });
});

// Pin "now" so the 6am-local due-window check is deterministic regardless
// of when the test runs on the wall clock.
const NOW_AFTER_6AM = new Date('2026-04-24T08:00:00Z');
const NEXT_DAY_AFTER_6AM = new Date('2026-04-25T08:00:00Z');

test("runAutoDreaming: with setting on + due window, fires startDreaming and creates rows", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_dreaming: true });
    await upsertProfile({ displayName: "T", locale: "en", timezone: "UTC" });

    await runAutoDreaming(makeApi(), { now: NOW_AFTER_6AM });

    // The tick fires startDreaming which is fire-and-forget; wait for the
    // background task to land at least one dream_run row.
    const seenRow = await waitFor(async () => (await listDreamRuns()).length > 0);
    assert.equal(seenRow, true, "expected runAutoDreaming to create a dream_run");

    const runs = await listDreamRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.trigger, "auto");

    // Wait for the run to complete (with stubbed subagent it should be fast).
    const completed = await waitFor(async () => {
      const r = await listDreamRuns();
      return r[0]?.status === "completed";
    });
    assert.equal(completed, true);

    const evol = await listEvolutionRuns({ triggerKind: "daily_dream", limit: 5 });
    assert.equal(evol.length, 1);
    assert.equal(evol[0]!.status, "completed");
  });
});

test("runAutoDreaming: skipped when a dream already completed today (same local day)", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_dreaming: true });
    await upsertProfile({ displayName: "T", locale: "en", timezone: "UTC" });

    // First tick: should kick off + complete one auto dream.
    await runAutoDreaming(makeApi(), { now: NOW_AFTER_6AM });
    await waitFor(async () => (await listDreamRuns())[0]?.status === "completed");
    assert.equal((await listDreamRuns()).length, 1);

    // Second tick (same day, +30min): the due-window check should suppress it.
    const sameDayLater = new Date(NOW_AFTER_6AM.getTime() + 30 * 60_000);
    await runAutoDreaming(makeApi(), { now: sameDayLater });
    await new Promise((r) => setTimeout(r, 100));

    const runs = await listDreamRuns();
    assert.equal(runs.length, 1, "second tick must not create a second dream the same day");
  });
});

test("runAutoDreaming: re-fires next local day", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_dreaming: true });
    await upsertProfile({ displayName: "T", locale: "en", timezone: "UTC" });

    await runAutoDreaming(makeApi(), { now: NOW_AFTER_6AM });
    await waitFor(async () => (await listDreamRuns())[0]?.status === "completed");

    await runAutoDreaming(makeApi(), { now: NEXT_DAY_AFTER_6AM });
    const seenSecond = await waitFor(async () => (await listDreamRuns()).length === 2);
    assert.equal(seenSecond, true, "next-day tick must produce a 2nd dream_run");
  });
});

// Phase C regression: when the background_tasks scheduler owns dreaming,
// the legacy in-process runAutoDreaming MUST be a no-op. Otherwise a user
// running both paths gets two dreams a day.
test("runAutoDreaming: no-op when BACKGROUND_AUTO_LOOP_TASKS_ENABLED=1 (Phase C gate)", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_dreaming: true });
    await upsertProfile({ displayName: "T", locale: "en", timezone: "UTC" });

    const previous = process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
    process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED = '1';
    try {
      await runAutoDreaming(makeApi(), { now: NOW_AFTER_6AM });
      // Settle any pending fire-and-forget — none should land
      await new Promise((r) => setTimeout(r, 100));
      const runs = await listDreamRuns();
      assert.equal(runs.length, 0, "scheduler-owned mode must NOT create dream_runs in-process");
    } finally {
      if (previous === undefined) delete process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
      else process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED = previous;
    }
  });
});

// ── runAutoCrystallize ──────────────────────────────────────────────────
//
// Same shape: respects the auto_crystallize setting; calling it with the
// setting off must be a no-op. With the setting on but no chat turns
// accumulated, runCrystallize bails before doing real work but the
// observability evolution_run is still opened.

test("runAutoCrystallize: skipped when auto_crystallize setting is off", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_crystallize: false });

    await runAutoCrystallize(makeApi());

    const evol = await listEvolutionRuns({ triggerKind: "chat_burst", limit: 5 });
    assert.equal(evol.length, 0, "off setting must short-circuit before opening evolution_run");
  });
});

test("runAutoCrystallize: with setting on but turn count below threshold, opens evolution_run + skips work", async () => {
  await withTempHome(async () => {
    await updateUserSettings({ auto_crystallize: true });
    // Default messageThreshold=10, so a single bumped turn is well below.
    await bumpCrystallizeTurn("agent:main:proactive-ai:chat:abc");

    await runAutoCrystallize(makeApi());

    const evol = await listEvolutionRuns({ triggerKind: "chat_burst", limit: 5 });
    assert.equal(evol.length, 1, "evolution_run mirror always opens when setting is on");
    assert.equal(evol[0]!.memories_written, 0);
    assert.equal(evol[0]!.skills_added, 0);
    assert.equal(evol[0]!.status, "completed");
  });
});
