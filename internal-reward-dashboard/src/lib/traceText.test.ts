import { describe, expect, it } from "vitest";
import {
  inferredDataSources,
  readableTraceLines,
  runCards,
  traceReviewMarkdown,
  traceStatusClass,
  traceStatusLabel,
} from "./traceText";
import type { RunDetail, TraceArtifact } from "@/api/reward";

describe("trace text formatting", () => {
  it("keeps trace status labels and CSS classes on a whitelist", () => {
    expect(traceStatusClass("ready")).toBe("ready");
    expect(traceStatusLabel("ready")).toBe("已就绪");
    expect(traceStatusClass("unknown_status")).toBe("neutral");
    expect(traceStatusLabel("unknown_status")).toBe("未知");
    expect(traceStatusClass("<script>")).toBe("neutral");
  });

  it("keeps trace card helpers safe for malformed runtime card arrays", () => {
    const run = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [
        {
          card: { id: "card_1", sources: ["memory[1] useful detail"] },
          evaluation: null,
          rewards: {
            userReward: 0,
            reviewerReward: null,
            displayReward: 0,
            opened: false,
            latestUserScoreAt: null,
            latestReviewerScoreAt: null,
          },
          rewardHistory: [],
          casebook: null,
          feedbackEvents: [],
        },
        null,
        { missingCard: true },
      ],
      trace: null,
    } as unknown as RunDetail;
    const trace: TraceArtifact = {
      runId: "root_run_1",
      status: "ready",
      traceTree: {},
      summary: {},
    };

    expect(runCards(run)).toHaveLength(1);
    expect(inferredDataSources(run)).toEqual(["memory"]);
    expect(traceReviewMarkdown({
      dataSources: [],
      routeRunId: "root_run_1",
      run: { ...run, cards: "bad" as unknown as RunDetail["cards"] },
      trace,
    })).toContain("- 当前批次没有保存卡片。");
  });

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

  it("exports a trace review markdown handoff with local paths", () => {
    const trace: TraceArtifact = {
      runId: "root_run_1",
      langsmithTraceId: "ls_1",
      langsmithUrl: "https://smith.langchain.com/o/trace/root_run_1",
      status: "ready",
      traceTree: { svg: "<svg />" },
      summary: { dataSources: ["memory"], missingStages: [] },
      imageFormat: "svg",
      imagePath: null,
      error: null,
      generatedAt: "2026-05-14T00:00:00Z",
    };
    const run: RunDetail = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: "2026-05-14T00:00:00Z",
        completedAt: "2026-05-14T00:01:00Z",
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: {
          id: "card_1",
          title: "AHA card",
          summary: "summary",
          whyNow: "why now",
          sources: ["memory[1] useful detail"],
        },
        evaluation: {
          cardId: "card_1",
          runId: "root_run_1",
          intentKey: null,
          basket: null,
          dimensions: {
            relevance: 8,
            actionability: 8,
            whyNowClarity: 8,
            novelty: 8,
            decisionCompression: 8,
          },
          overall: 8,
          pass: true,
          evaluator: "eval",
          feedback: "good card",
          evaluatedAt: "2026-05-14T00:01:00Z",
        },
        rewards: {
          userReward: 0,
          reviewerReward: null,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      }],
      trace,
    };

    const markdown = traceReviewMarkdown({
      dataSources: ["memory"],
      routeRunId: "root_run_1",
      run,
      trace,
    });

    expect(markdown).toContain("- 批次评审: /runs/run_pk_1");
    expect(markdown).toContain("- 生成链路: /traces/root_run_1");
    expect(markdown).toContain("- 首张卡片: /cards/card_1");
    expect(markdown).toContain("#### 输入来源");
    expect(markdown).toContain("#### 卡片概览");
    expect(markdown).toContain("1. AHA card");
    expect(markdown).toContain("- 卡片详情: /cards/card_1");
    expect(markdown).toContain("- 用户/人工/评估: 0.0 / - / 8.0");
    expect(markdown).toContain("good card");
  });

  it("formats non-finite trace card scores as missing values", () => {
    const trace: TraceArtifact = {
      runId: "root_run_1",
      status: "ready",
      traceTree: { svg: "<svg />" },
      summary: {},
    };
    const run: RunDetail = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: { id: "card_1", title: "AHA card", summary: "summary" },
        evaluation: {
          cardId: "card_1",
          runId: "root_run_1",
          intentKey: null,
          basket: null,
          dimensions: {
            relevance: null,
            actionability: null,
            whyNowClarity: null,
            novelty: null,
            decisionCompression: null,
          },
          overall: Number.NaN,
          pass: true,
          evaluator: null,
          feedback: null,
          evaluatedAt: null,
        },
        rewards: {
          userReward: Number.POSITIVE_INFINITY,
          reviewerReward: Number.NaN,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      }],
      trace,
    };

    const markdown = traceReviewMarkdown({
      dataSources: [],
      routeRunId: "root_run_1",
      run,
      trace,
    });

    expect(markdown).toContain("- 用户/人工/评估: - / - / -");
    expect(markdown).not.toContain("NaN");
    expect(markdown).not.toContain("Infinity");
  });

  it("redacts sensitive-looking trace markdown card fields before export", () => {
    const trace: TraceArtifact = {
      runId: "root_run_1",
      status: "ready",
      traceTree: { svg: "<svg />" },
      summary: {},
    };
    const run: RunDetail = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: {
          id: "card_1",
          title: "AHA card",
          summary: "summary api_key=secret-api-key",
          whyNow: "Authorization: Bearer secret-access-token",
          sources: ["https://example.com/callback?access_token=secret-source-token&state=visible"],
        },
        evaluation: {
          cardId: "card_1",
          runId: "root_run_1",
          intentKey: null,
          basket: null,
          dimensions: {
            relevance: 8,
            actionability: 8,
            whyNowClarity: 8,
            novelty: 8,
            decisionCompression: 8,
          },
          overall: 8,
          pass: true,
          evaluator: null,
          feedback: "refresh_token=secret-refresh-token",
          evaluatedAt: null,
        },
        rewards: {
          userReward: 0,
          reviewerReward: null,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      }],
      trace,
    };

    const markdown = traceReviewMarkdown({
      dataSources: [],
      routeRunId: "root_run_1",
      run,
      trace,
    });

    expect(markdown).toContain("已隐藏敏感值");
    expect(markdown).not.toContain("secret-api-key");
    expect(markdown).not.toContain("secret-access-token");
    expect(markdown).not.toContain("secret-source-token");
    expect(markdown).not.toContain("secret-refresh-token");
  });

  it("marks missing trace route links as unavailable in markdown exports", () => {
    const trace: TraceArtifact = {
      runId: "   ",
      langsmithUrl: "javascript:alert(1)",
      status: "ready",
      traceTree: { svg: "<svg />" },
      summary: { dataSources: ["memory"], missingStages: [] },
      imageFormat: "svg",
      imagePath: null,
      error: null,
      generatedAt: "2026-05-14T00:00:00Z",
    };
    const run: RunDetail = {
      ok: true,
      run: {
        id: "   ",
        runId: "   ",
        status: "completed",
        trigger: "manual",
        startedAt: "2026-05-14T00:00:00Z",
        completedAt: "2026-05-14T00:01:00Z",
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: {
          id: "   ",
          title: "AHA card",
          summary: "summary",
          whyNow: "why now",
        },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: null,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      }],
      trace,
    };

    const markdown = traceReviewMarkdown({
      dataSources: ["memory"],
      routeRunId: "   ",
      run,
      trace,
    });

    expect(markdown).toContain("- 批次评审: 未保存");
    expect(markdown).toContain("### 生成链路复盘 未保存");
    expect(markdown).toContain("- 生成链路: 未保存");
    expect(markdown).toContain("- 首张卡片: 未保存");
    expect(markdown).toContain("- 卡片详情: 未保存");
    expect(markdown).toContain("- LangSmith: 未绑定");
    expect(markdown).not.toContain("javascript:");
  });

  it("does not mark invalid trace SVG as generated in markdown exports", () => {
    const trace: TraceArtifact = {
      runId: "root_run_1",
      status: "ready",
      traceTree: { svg: "<script>alert(1)</script>" },
      summary: { dataSources: ["memory"], missingStages: [] },
      imageFormat: "svg",
      imagePath: null,
      error: null,
      generatedAt: "2026-05-14T00:00:00Z",
    };

    const markdown = traceReviewMarkdown({
      dataSources: ["memory"],
      routeRunId: "root_run_1",
      run: null,
      trace,
    });

    expect(markdown).toContain("- Trace 图: 未生成");
  });

  it("marks truncated trace review markdown when the run has more than eight cards", () => {
    const trace: TraceArtifact = {
      runId: "root_run_1",
      status: "ready",
      traceTree: { svg: "<svg />" },
      summary: { dataSources: ["memory"], missingStages: [] },
      imageFormat: "svg",
      imagePath: null,
      error: null,
      generatedAt: "2026-05-14T00:00:00Z",
    };
    const run: RunDetail = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: "2026-05-14T00:00:00Z",
        completedAt: "2026-05-14T00:01:00Z",
        totalIterations: null,
        error: null,
      },
      cards: Array.from({ length: 9 }, (_, index) => ({
        card: {
          id: `card_${index + 1}`,
          title: `Card ${index + 1}`,
          summary: `summary ${index + 1}`,
          whyNow: `why ${index + 1}`,
        },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: null,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      })),
      trace,
    };

    const markdown = traceReviewMarkdown({
      dataSources: ["memory"],
      routeRunId: "root_run_1",
      run,
      trace,
    });

    expect(markdown).toContain("8. Card 8");
    expect(markdown).not.toContain("9. Card 9");
    expect(markdown).toContain("还有 1 张卡未写入复制摘要");
  });

  it("clips oversized trace card fields in markdown exports", () => {
    const trace: TraceArtifact = {
      runId: "root_run_1",
      status: "ready",
      traceTree: { svg: "<svg />" },
      summary: { dataSources: ["memory"], missingStages: [] },
    };
    const longTitle = "title detail ".repeat(40);
    const longSummary = "summary detail ".repeat(80);
    const longWhyNow = "why now detail ".repeat(80);
    const run: RunDetail = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: {
          id: "card_1",
          title: longTitle,
          summary: longSummary,
          whyNow: longWhyNow,
        },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: null,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      }],
      trace,
    };

    const markdown = traceReviewMarkdown({
      dataSources: ["memory"],
      routeRunId: "root_run_1",
      run,
      trace,
    });

    expect(markdown).toContain("...");
    expect(markdown).not.toContain(longTitle.trim());
    expect(markdown).not.toContain(longSummary.trim());
    expect(markdown).not.toContain(longWhyNow.trim());
  });
});
