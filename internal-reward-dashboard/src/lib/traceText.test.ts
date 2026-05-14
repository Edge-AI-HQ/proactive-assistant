import { describe, expect, it } from "vitest";
import { readableTraceLines } from "./traceText";

describe("trace text formatting", () => {
  it("extracts reasoning from a truncated LangSmith generation preview", () => {
    const preview = "s (sandbox files) or its returned JSON.\\n\\n1. `task` output {'generations': [[{'text': '{\"reasoning\":\"本轮按顺序执行了 data-collector、planner、card-generator、evaluator 四个子代理：数据采集成功写入 /state/phase1.json，包含 memory=30、signals=2、gcal=20、cards_recent=30、feedback=6、world=10 等可用来源...";

    const lines = readableTraceLines([preview]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("本轮按顺序执行了");
    expect(lines[0]).not.toContain("generations");
    expect(lines[0]).not.toContain("sandbox files");
  });

  it("suppresses raw trace plumbing when no readable reasoning is present", () => {
    const lines = readableTraceLines([
      "outputsPreview={'generations': [[{'text': 'raw callback object'}]]}",
    ]);

    expect(lines).toEqual([]);
  });
});
