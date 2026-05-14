import { describe, expect, it } from "vitest";
import { casebookDeleteErrorMessage, scoreSaveErrorMessage } from "./reviewStatus";

describe("review status messages", () => {
  it("distinguishes score write failures from post-score refresh failures", () => {
    expect(scoreSaveErrorMessage(false, new Error("forbidden"))).toBe("评分保存失败：forbidden");
    expect(scoreSaveErrorMessage(true, new Error("reload failed"))).toBe(
      "评分已保存，但页面刷新失败：reload failed",
    );
  });

  it("distinguishes casebook delete failures from post-delete refresh failures", () => {
    expect(casebookDeleteErrorMessage(false, new Error("forbidden"))).toBe("移除失败：forbidden");
    expect(casebookDeleteErrorMessage(true, new Error("reload failed"))).toBe(
      "样本已移除，但页面刷新失败：reload failed",
    );
  });
});
