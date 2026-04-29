/**
 * /generate route smoke tests.
 *
 * Full integration of the dispatch + finalize lifecycle is exercised by the
 * pipeline-reconcile and auto-loop integration tests. This file just
 * verifies the cheap routing predicates (HTTP method gating, no-op on wrong
 * subpath).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { handleGenerate } from "./generate.ts";

function makeStubResponse() {
  const writes: string[] = [];
  return {
    writes,
    res: {
      writeHead: () => undefined,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: (chunk?: string) => {
        if (typeof chunk === "string") writes.push(chunk);
      },
      setHeader: () => undefined,
    } as unknown,
  };
}

test("handleGenerate ignores subpath that is not /generate", async () => {
  const handler = handleGenerate({ cards_to_generate: 8 });
  const stub = makeStubResponse();
  const handled = await handler({
    subpath: "/health",
    req: { method: "GET" } as never,
    res: stub.res as never,
    url: new URL("http://localhost/health"),
    api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
  });
  assert.equal(handled, false);
});

test("handleGenerate ignores non-GET/POST methods", async () => {
  const handler = handleGenerate({ cards_to_generate: 8 });
  const stub = makeStubResponse();
  const handled = await handler({
    subpath: "/generate",
    req: { method: "DELETE" } as never,
    res: stub.res as never,
    url: new URL("http://localhost/generate"),
    api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
  });
  assert.equal(handled, false);
});
