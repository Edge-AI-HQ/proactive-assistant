import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { handleHealth } from "./health.ts";
import {
  markPipelineRunFailed,
  resetDbForTests,
  savePipelineRun,
  savePipelineRunStart,
} from "../db.ts";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pin-health-route-"));
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

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      response.headers = headers;
      return response;
    },
    end(chunk?: string) {
      if (chunk) response.body += chunk;
      return response;
    },
  };
  return response;
}

function createRequest(method: string) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  req.end();
  return req;
}

test("GET /status does not surface stale completed cards when a newer run failed", async () => {
  await withTempHome(async () => {
    await savePipelineRun({
      runId: "run_old_completed",
      status: "completed",
      finalCards: [{ id: "old_1", title: "Old English card" }],
      details: { evaluation: { batchFeedback: "old batch" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await savePipelineRunStart({
      runId: "run_new_failed",
      trigger: "manual",
      subagentRunId: "subagent-new",
      subagentSessionKey: "session-new",
    });
    await markPipelineRunFailed({
      runId: "run_new_failed",
      error: "subagent aborted",
    });

    const handler = handleHealth();
    const res = createResponse();
    const handled = await handler({
      subpath: "/status",
      req: createRequest("GET"),
      res,
      url: new URL("http://localhost/status"),
      api: {} as never,
    } as never);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.pipelineRunning, false);
    assert.equal(body.latestRun.id, "run_new_failed");
    assert.equal(body.latestRun.status, "failed");
    assert.equal(body.lastResult, null);
  });
});
