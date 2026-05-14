import { describe, expect, it } from "vitest";
import { initialLoadRecoveryVisible, staleRefreshErrorMessage } from "./recoveryState";

describe("initialLoadRecoveryVisible", () => {
  it("shows recovery only when the first load failed before data was available", () => {
    expect(initialLoadRecoveryVisible("network failed", null)).toBe(true);
    expect(initialLoadRecoveryVisible("network failed", { id: "loaded" })).toBe(false);
    expect(initialLoadRecoveryVisible(null, null)).toBe(false);
  });
});

describe("staleRefreshErrorMessage", () => {
  it("explains stale visible data only after a successful prior load", () => {
    expect(staleRefreshErrorMessage("network failed", { id: "loaded" }, "批次")).toBe(
      "批次刷新失败，当前仍显示上一次成功加载的数据：network failed",
    );
    expect(staleRefreshErrorMessage("network failed", null, "批次")).toBeNull();
    expect(staleRefreshErrorMessage(null, { id: "loaded" }, "批次")).toBeNull();
  });
});
