import { describe, expect, it } from "vitest";
import { stateBlockLiveMode, stateBlockRole } from "./StateBlock";

describe("StateBlock", () => {
  it("announces loading states politely and failures assertively", () => {
    expect(stateBlockRole(undefined)).toBe("status");
    expect(stateBlockRole("加载失败")).toBe("alert");
    expect(stateBlockLiveMode(undefined)).toBe("polite");
    expect(stateBlockLiveMode("加载失败")).toBe("assertive");
  });
});
