import test from "node:test";
import assert from "node:assert/strict";

import { guideCommandList } from "./guideCommandList.js";

test("includes /subscribe in guide command list", () => {
  const subscribeCommand = guideCommandList.find(
    (item) => item.command === "subscribe",
  );
  assert.ok(subscribeCommand);
});
