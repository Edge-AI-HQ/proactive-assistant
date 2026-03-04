import assert from "node:assert/strict";
import test from "node:test";

import { buildTelegramChannelConfigSection } from "./openclaw_config.js";

test("buildTelegramChannelConfigSection uses canonical telegram streaming key", () => {
  const config = buildTelegramChannelConfigSection("123456:ABCDEF");

  assert.equal(config.streaming, "partial");
  assert.equal(Object.hasOwn(config, "streamMode"), false);
});
