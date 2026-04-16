import test from "node:test";
import assert from "node:assert/strict";

import { buildOutputLanguageInstruction } from "./output-language.ts";

test("buildOutputLanguageInstruction treats zh alias as simplified Chinese", () => {
  const instruction = buildOutputLanguageInstruction("zh" as never, {
    fieldsDescription: "All user-visible fields",
  });

  assert.match(instruction, /Simplified Chinese/);
  assert.doesNotMatch(instruction, /written in English/);
});
