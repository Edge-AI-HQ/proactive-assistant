/**
 * /runs and /cards route smoke tests.
 *
 * Backs up the db.list-visible-cards.test.ts unit suite by exercising the
 * HTTP-shaped contract (subpath matching, query parsing, response envelope).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleRuns } from "./runs.ts";
import {
  markPipelineRunCompleted,
  resetDbForTests,
  savePipelineRunStart,
} from "../db.ts";

interface CapturedResponse {
  status: number | null;
  body: unknown;
}

function makeStubResponse(): { res: never; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: null, body: null };
  let buffer = "";
  const res = {
    writeHead: (status: number) => {
      captured.status = status;
    },
    write: (chunk: string) => {
      buffer += chunk;
      return true;
    },
    end: (chunk?: string) => {
      if (typeof chunk === "string") buffer += chunk;
      try {
        captured.body = buffer ? JSON.parse(buffer) : null;
      } catch {
        captured.body = buffer;
      }
    },
    setHeader: () => undefined,
  };
  return { res: res as never, captured };
}

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pin-routes-runs-"));
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

async function seedCompletedRun(
  runId: string,
  cards: Array<Record<string, unknown>>,
) {
  await savePipelineRunStart({
    runId,
    trigger: "manual",
    subagentRunId: `${runId}-sub`,
    subagentSessionKey: `${runId}-key`,
  });
  await markPipelineRunCompleted({
    runId,
    finalCards: cards,
    details: { plan: { reasoning: "" }, evaluation: { batchFeedback: "" } },
  });
}

test("GET /cards: returns cards across runs newest-first", async () => {
  await withTempHome(async () => {
    await seedCompletedRun("run-old", [
      { id: "run-old_1", goalBasket: "work", title: "Old" },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    await seedCompletedRun("run-new", [
      { id: "run-new_1", goalBasket: "work", title: "New" },
    ]);

    const handler = handleRuns();
    const stub = makeStubResponse();
    const handled = await handler({
      subpath: "/cards",
      req: { method: "GET" } as never,
      res: stub.res,
      url: new URL("http://localhost/cards"),
      api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
    });

    assert.equal(handled, true);
    assert.equal(stub.captured.status, 200);
    const body = stub.captured.body as { ok: boolean; cards: Array<{ runId: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.cards.length, 2);
    assert.equal(body.cards[0]!.runId, "run-new");
    assert.equal(body.cards[1]!.runId, "run-old");
  });
});

test("GET /cards?limit=1: clamps result count", async () => {
  await withTempHome(async () => {
    await seedCompletedRun("run-1", [
      { id: "run-1_1", goalBasket: "work", title: "A" },
      { id: "run-1_2", goalBasket: "work", title: "B" },
    ]);

    const handler = handleRuns();
    const stub = makeStubResponse();
    await handler({
      subpath: "/cards",
      req: { method: "GET" } as never,
      res: stub.res,
      url: new URL("http://localhost/cards?limit=1"),
      api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
    });

    const body = stub.captured.body as { cards: unknown[] };
    assert.equal(body.cards.length, 1);
  });
});

test("GET /cards: empty when no completed runs", async () => {
  await withTempHome(async () => {
    const handler = handleRuns();
    const stub = makeStubResponse();
    await handler({
      subpath: "/cards",
      req: { method: "GET" } as never,
      res: stub.res,
      url: new URL("http://localhost/cards"),
      api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
    });
    assert.equal(stub.captured.status, 200);
    const body = stub.captured.body as { ok: boolean; cards: unknown[] };
    assert.deepEqual(body, { ok: true, cards: [] });
  });
});

test("GET /runs: still returns just the latest completed run (singleton kept for callers)", async () => {
  await withTempHome(async () => {
    await seedCompletedRun("run-old", [
      { id: "run-old_1", goalBasket: "work", title: "Old" },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    await seedCompletedRun("run-new", [
      { id: "run-new_1", goalBasket: "work", title: "New" },
    ]);

    const handler = handleRuns();
    const stub = makeStubResponse();
    await handler({
      subpath: "/runs",
      req: { method: "GET" } as never,
      res: stub.res,
      url: new URL("http://localhost/runs"),
      api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
    });

    const body = stub.captured.body as { ok: boolean; runs: Array<{ id: string }> };
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0]!.id, "run-new");
  });
});
