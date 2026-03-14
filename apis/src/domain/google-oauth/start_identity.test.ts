import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMiniGoogleStartIdentity,
  type MiniInitDataVerification,
} from "./start_identity.js";

test("validateMiniGoogleStartIdentity rejects empty init_data", () => {
  const result = validateMiniGoogleStartIdentity("", 123, () => ({
    ok: true,
    telegramUserId: 123,
    telegramUsername: "u",
  }));
  assert.deepEqual(result, {
    ok: false,
    error: "Unauthorized: missing Telegram init_data",
    shouldClearSession: true,
  });
});

test("validateMiniGoogleStartIdentity rejects invalid init_data", () => {
  const result = validateMiniGoogleStartIdentity(
    "bad",
    123,
    (): MiniInitDataVerification => ({ ok: false, error: "invalid hash" }),
  );
  assert.deepEqual(result, {
    ok: false,
    error: "invalid hash",
    shouldClearSession: true,
  });
});

test("validateMiniGoogleStartIdentity rejects mismatched user id", () => {
  const result = validateMiniGoogleStartIdentity("ok", 123, () => ({
    ok: true,
    telegramUserId: 999,
    telegramUsername: "u",
  }));
  assert.deepEqual(result, {
    ok: false,
    error: "Unauthorized: session user mismatch",
    shouldClearSession: true,
  });
});

test("validateMiniGoogleStartIdentity accepts matching user id", () => {
  const result = validateMiniGoogleStartIdentity("ok", 123, () => ({
    ok: true,
    telegramUserId: 123,
    telegramUsername: "u",
  }));
  assert.deepEqual(result, { ok: true });
});
