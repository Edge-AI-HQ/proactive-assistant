import { describe, expect, it } from "vitest";

import { PIN_AI_CORE } from "@pin-ai/core";

import { PIN_AI_STATE } from "./index";

describe("@pin-ai/state", () => {
  it("package skeleton is wired", () => {
    expect(PIN_AI_STATE).toBe("@pin-ai/state");
  });

  it("resolves @pin-ai/core from source (state→core 依赖方向)", () => {
    expect(PIN_AI_CORE).toBe("@pin-ai/core");
  });
});
