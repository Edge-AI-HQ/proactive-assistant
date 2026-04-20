import test from "node:test";
import assert from "node:assert/strict";

import { buildContentSnapshot } from "../src/components/chat/tool-steps";

test("buildContentSnapshot: text-only snapshot when no tool steps", () => {
  const parts = buildContentSnapshot([], "hello world");
  assert.deepEqual(parts, [{ type: "text", text: "hello world" }]);
});

test("buildContentSnapshot: tool-call parts come before the text part", () => {
  const parts = buildContentSnapshot(
    [
      {
        toolCallId: "call-1",
        toolName: "exec",
        meta: "ls /",
        argsPreview: "command=ls /",
        status: "running",
      },
    ],
    "",
  );

  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "tool-call");
  assert.deepEqual(parts[1], { type: "text", text: "" });

  if (parts[0].type !== "tool-call") throw new Error("unreachable");
  assert.equal(parts[0].toolCallId, "call-1");
  assert.equal(parts[0].toolName, "exec");
  assert.deepEqual(parts[0].args, {
    status: "running",
    meta: "ls /",
    argsPreview: "command=ls /",
  });
  assert.equal(parts[0].result, undefined);
  assert.equal(parts[0].isError, undefined);
  assert.equal(typeof parts[0].argsText, "string");
});

test("buildContentSnapshot: completed tool step has result.ok=true and no isError", () => {
  const parts = buildContentSnapshot(
    [
      {
        toolCallId: "call-1",
        toolName: "exec",
        pinCommand: "personal exec --tool GMAIL_FETCH_EMAILS",
        status: "ok",
      },
    ],
    "done",
  );

  if (parts[0].type !== "tool-call") throw new Error("unreachable");
  assert.deepEqual(parts[0].result, { ok: true });
  assert.equal(parts[0].isError, undefined);
  assert.deepEqual(parts[0].args, {
    status: "ok",
    pinCommand: "personal exec --tool GMAIL_FETCH_EMAILS",
  });
  assert.deepEqual(parts[1], { type: "text", text: "done" });
});

test("buildContentSnapshot: failed tool step has result.ok=false and isError=true", () => {
  const parts = buildContentSnapshot(
    [
      {
        toolCallId: "call-1",
        toolName: "exec",
        status: "error",
      },
    ],
    "",
  );

  if (parts[0].type !== "tool-call") throw new Error("unreachable");
  assert.deepEqual(parts[0].result, { ok: false });
  assert.equal(parts[0].isError, true);
});

test("buildContentSnapshot: preserves tool step order", () => {
  const parts = buildContentSnapshot(
    [
      { toolCallId: "a", toolName: "exec", status: "ok" },
      { toolCallId: "b", toolName: "browser", status: "running" },
    ],
    "streaming...",
  );

  assert.deepEqual(parts.map((p) => p.type), ["tool-call", "tool-call", "text"]);
  if (parts[0].type !== "tool-call" || parts[1].type !== "tool-call") {
    throw new Error("unreachable");
  }
  assert.equal(parts[0].toolCallId, "a");
  assert.equal(parts[1].toolCallId, "b");
});
