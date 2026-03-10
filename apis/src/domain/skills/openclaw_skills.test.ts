import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PREINSTALLED_BUNDLED_SKILLS,
  readSkillsConfigFromRuntimeMetadata,
} from "./openclaw_skills.js";

test("readSkillsConfigFromRuntimeMetadata applies default bundled google workspace skills", () => {
  const config = readSkillsConfigFromRuntimeMetadata({});
  assert.ok(config);

  const allowBundled = new Set(config.allowBundled || []);
  for (const key of DEFAULT_PREINSTALLED_BUNDLED_SKILLS) {
    assert.equal(allowBundled.has(key), true, `expected bundled skill ${key}`);
    assert.equal(config.entries?.[key]?.enabled, true, `expected enabled entry for ${key}`);
  }
});
