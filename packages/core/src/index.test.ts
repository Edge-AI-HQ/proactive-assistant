import { describe, expect, it } from "vitest";

import { PIN_AI_CORE } from "./index";

describe("@pin-ai/core", () => {
  it("package skeleton is wired", () => {
    expect(PIN_AI_CORE).toBe("@pin-ai/core");
  });
});
