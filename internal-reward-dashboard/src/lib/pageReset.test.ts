import { describe, expect, it } from "vitest";
import { shouldWaitForPageReset } from "./pageReset";

describe("shouldWaitForPageReset", () => {
  it("waits only when filters changed away from page one", () => {
    expect(shouldWaitForPageReset(true, 3)).toBe(true);
    expect(shouldWaitForPageReset(true, 1)).toBe(false);
    expect(shouldWaitForPageReset(false, 3)).toBe(false);
  });
});
