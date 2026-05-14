import { describe, expect, it } from "vitest";
import { REWARD_TEXT_FILTER_MAX_LENGTH, textFilterLengthError } from "./textFilter";

describe("textFilterLengthError", () => {
  it("allows empty, blank, and in-range text filters", () => {
    expect(textFilterLengthError(undefined, "触发来源")).toBeNull();
    expect(textFilterLengthError("   ", "触发来源")).toBeNull();
    expect(textFilterLengthError("x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH), "触发来源")).toBeNull();
  });

  it("checks the trimmed filter length against the backend limit", () => {
    expect(textFilterLengthError(
      `  ${"x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1)}  `,
      "触发来源",
    )).toBe(`触发来源不能超过 ${REWARD_TEXT_FILTER_MAX_LENGTH} 个字符。`);
  });
});
