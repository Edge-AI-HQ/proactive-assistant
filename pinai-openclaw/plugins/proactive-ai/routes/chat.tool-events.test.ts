import test from "node:test";
import assert from "node:assert/strict";

import { detectPinCommand, previewToolArgs } from "./chat.ts";

test("previewToolArgs picks known keys and truncates", () => {
  assert.equal(previewToolArgs(undefined), undefined);
  assert.equal(previewToolArgs({}), undefined);
  assert.equal(
    previewToolArgs({ command: "ls -la" }),
    "command=ls -la",
  );
  assert.equal(
    previewToolArgs({ query: "emails from alice", limit: 10 }),
    "query=emails from alice",
  );
  const long = "x".repeat(400);
  const out = previewToolArgs({ command: long });
  assert.ok(out && out.length <= 200, `expected <=200, got ${out?.length}`);
  assert.ok(out?.endsWith("…"));
});

test("previewToolArgs combines multiple detail keys", () => {
  const out = previewToolArgs({ tool: "GMAIL_FETCH_EMAILS", input: { q: "is:important" } });
  assert.ok(out?.includes("tool=GMAIL_FETCH_EMAILS"));
  assert.ok(out?.includes("input="));
});

test("detectPinCommand returns undefined for non-exec tools", () => {
  assert.equal(detectPinCommand("browser", { command: "pin personal exec" }), undefined);
  assert.equal(detectPinCommand("read", { path: "/tmp/x" }), undefined);
});

test("detectPinCommand extracts pin subcommand from exec args", () => {
  assert.equal(
    detectPinCommand("exec", { command: "pin personal exec --tool GMAIL_FETCH_EMAILS --json" }),
    "personal exec --tool GMAIL_FETCH_EMAILS --json",
  );
  assert.equal(
    detectPinCommand("exec", { command: "  pin world overview --json" }),
    "world overview --json",
  );
});

test("detectPinCommand handles shell prefixes and chains", () => {
  assert.equal(
    detectPinCommand("exec", { command: "cd /tmp && pin personal status --json" }),
    "personal status --json",
  );
  assert.equal(
    detectPinCommand("exec", { command: "echo hi; pin feedback submit" }),
    "feedback submit",
  );
});

test("detectPinCommand ignores commands that merely contain 'pin'", () => {
  assert.equal(detectPinCommand("exec", { command: "ping 8.8.8.8" }), undefined);
  assert.equal(detectPinCommand("exec", { command: "cat pin.txt" }), undefined);
});

test("detectPinCommand truncates very long subcommands", () => {
  const big = `pin personal exec --input '${"y".repeat(500)}'`;
  const out = detectPinCommand("exec", { command: big });
  assert.ok(out && out.length <= 200);
  assert.ok(out?.endsWith("…"));
});
