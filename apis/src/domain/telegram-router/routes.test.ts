import test from "node:test";
import assert from "node:assert/strict";

import { isGuideBotCommandText } from "./guideCommands.js";

test("recognizes /subscribe command", () => {
  assert.equal(isGuideBotCommandText("/subscribe"), true);
  assert.equal(isGuideBotCommandText("/subscribe@pinclaw_bot"), true);
});

test("ignores non-guide commands", () => {
  assert.equal(isGuideBotCommandText("/unknown"), false);
  assert.equal(isGuideBotCommandText("subscribe"), false);
});
