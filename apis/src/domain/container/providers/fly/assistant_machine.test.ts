import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssistantVolumeNameForTest,
  normalizeOwnerTelegramUserIdForTest,
} from "./assistant_machine.js";

test("normalizeOwnerTelegramUserIdForTest accepts valid numeric telegram id", () => {
  assert.equal(normalizeOwnerTelegramUserIdForTest("6142814327"), "6142814327");
});

test("normalizeOwnerTelegramUserIdForTest rejects empty or invalid telegram id", () => {
  assert.throws(
    () => normalizeOwnerTelegramUserIdForTest(""),
    /ownerTelegramUserId must be a positive integer string/,
  );
  assert.throws(
    () => normalizeOwnerTelegramUserIdForTest("abc"),
    /ownerTelegramUserId must be a positive integer string/,
  );
  assert.throws(
    () => normalizeOwnerTelegramUserIdForTest("0"),
    /ownerTelegramUserId must be a positive integer string/,
  );
});

test("buildAssistantVolumeNameForTest uses telegram id as stable suffix", () => {
  const name = buildAssistantVolumeNameForTest("6142814327", "openclaw-user");
  assert.equal(name, "openclaw_user_6142814327");
});

test("buildAssistantVolumeNameForTest sanitizes prefix and respects length limit", () => {
  const name = buildAssistantVolumeNameForTest(
    "12345678901234567890",
    "OPENCLAW-USER-LONG-PREFIX-NEEDS-TRIM",
  );
  assert.match(name, /^[a-z0-9_]+$/);
  assert.ok(name.endsWith("_12345678901234567890"));
  assert.ok(name.length <= 30);
});
