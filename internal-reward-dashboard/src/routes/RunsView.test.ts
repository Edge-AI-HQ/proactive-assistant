import { describe, expect, it, vi } from "vitest";
import {
  agentRunToSummary,
  agentRunSummaries,
  canOpenRunArtifacts,
  canOpenRunTrace,
  evaluatorGap,
  evaluatorGapMagnitude,
  MANUAL_GENERATOR_MAX_ATTEMPTS,
  mergeActiveAndPersistedRuns,
  primaryWorkloadAction,
  remainingReviews,
  reviewPercent,
  runMatchesFocus,
  runDetailRouteId,
  runSummaries,
  runStatusClass,
  runsFilterError,
  runTraceRouteId,
  shortRunId,
  runsBlockingError,
  runsHideStaleRows,
  runsInitialLoading,
  runsQueryEquals,
  runsRefreshErrorText,
  runsTableEmptyMessage,
  runsWorkloadSummary,
  signalText,
  traceCell,
} from "./RunsView";
import { REWARD_TEXT_FILTER_MAX_LENGTH } from "@/api/reward";
import type { RunSummary } from "@/api/reward";
import type { AgentRunSummary } from "@/api/reward";

vi.mock("@/auth/supabase", () => ({
  accessToken: async () => "test-token",
  refreshAccessToken: async () => "test-token",
}));

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run_1",
    runId: "langsmith_run_1",
    status: "completed",
    trigger: "manual",
    startedAt: "2026-05-14T10:00:00.000Z",
    completedAt: "2026-05-14T10:05:00.000Z",
    cardCount: 8,
    avgUserReward: 6,
    avgReviewerReward: null,
    deadCardRate: null,
    ahaRate: null,
    reviewedCount: 8,
    casebookCount: 0,
    avgEvaluatorOverall: 6,
    traceStatus: "ready",
    reviewLatencyHours: null,
    ...overrides,
  };
}

function activeRun(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: "gen.abc",
    kind: "generator.manual",
    status: "running",
    trigger: "manual",
    startedAt: "2026-05-14T10:00:00.000Z",
    completedAt: null,
    createdAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:00:01.000Z",
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    progress: {},
    payload: {},
    ...overrides,
  };
}

describe("RunsView batch list rules", () => {
  it("matches the backend manual generator retry limit for optimistic rows", () => {
    expect(MANUAL_GENERATOR_MAX_ATTEMPTS).toBe(2);
  });

  it("keeps malformed runtime run arrays out of the workbench state", () => {
    expect(runSummaries([
      run({ id: "run_1", runId: "root_1" }),
      null,
      { id: 42, runId: "root_bad" },
      { id: "run_missing_root" },
    ])).toEqual([run({ id: "run_1", runId: "root_1" })]);
    expect(runSummaries("bad")).toEqual([]);
  });

  it("keeps malformed runtime agent-run arrays out of active generation state", () => {
    expect(agentRunSummaries([
      activeRun({ id: "task_1", kind: "generator.manual", status: "running" }),
      null,
      { id: "missing_status", kind: "generator.manual" },
      { id: 42, kind: "generator.manual", status: "running" },
    ])).toEqual([activeRun({ id: "task_1", kind: "generator.manual", status: "running" })]);
    expect(agentRunSummaries("bad")).toEqual([]);
  });

  it("surfaces active generation attempts and concrete failures", () => {
    const running = agentRunToSummary(activeRun({ attempts: 2, maxAttempts: 3 }));
    const badAttempts = agentRunToSummary(activeRun({
      attempts: Number.NaN,
      maxAttempts: Number.POSITIVE_INFINITY,
    }));
    const failed = agentRunToSummary(activeRun({
      status: "failed",
      lastError: "LLM timeout while evaluating cards",
    }));

    expect(signalText(running)).toContain("尝试 2/3");
    expect(signalText(badAttempts)).not.toContain("NaN");
    expect(signalText(badAttempts)).not.toContain("Infinity");
    expect(signalText(badAttempts)).toContain("生成进行中");
    expect(signalText(failed)).toContain("LLM timeout while evaluating cards");
  });

  it("does not point failed generator rows at missing task logs", () => {
    const failed = agentRunToSummary(activeRun({
      status: "failed",
      lastError: null,
    }));

    expect(signalText(failed)).toBe("生成失败：没有返回错误详情，请重新触发或刷新批次列表确认是否已落库");
    expect(signalText(failed)).not.toContain("查看任务日志");
  });

  it("opens persisted empty runs but not unresolved active placeholders", () => {
    const persistedEmpty = run({ cardCount: 0, reviewedCount: 0, status: "completed" });
    const failedPlaceholder = agentRunToSummary(activeRun({
      status: "failed",
      lastError: "generator failed before persisting a run",
    }));

    expect(canOpenRunArtifacts(persistedEmpty)).toBe(true);
    expect(canOpenRunArtifacts(failedPlaceholder)).toBe(false);
  });

  it("requires usable route ids before enabling persisted run actions", () => {
    const dbOnly = run({ id: " run_pk_1 ", runId: "   " });
    const rootOnly = run({ id: "   ", runId: " root_run_1 " });
    const missingIds = run({ id: "   ", runId: "   " });

    expect(runDetailRouteId(dbOnly)).toBe("run_pk_1");
    expect(runTraceRouteId(rootOnly)).toBe("root_run_1");
    expect(shortRunId(rootOnly)).toBe("root_run_1");
    expect(shortRunId(missingIds)).toBe("未保存");
    expect(canOpenRunArtifacts(dbOnly)).toBe(true);
    expect(canOpenRunTrace(rootOnly)).toBe(true);
    expect(canOpenRunArtifacts(missingIds)).toBe(false);
    expect(canOpenRunTrace(missingIds)).toBe(false);
  });

  it("keeps backend status values out of raw CSS class names", () => {
    expect(runStatusClass(run({ status: "running" }))).toBe("running");
    expect(runStatusClass(run({ status: "completed", cardCount: 0 }))).toBe("empty");
    expect(runStatusClass(run({ status: "waiting for reviewer" }))).toBe("neutral");
    expect(runStatusClass(run({ status: "<script>" }))).toBe("neutral");
  });

  it("keeps backend trace statuses out of raw CSS class names", () => {
    expect(traceCell(run({ traceStatus: "missing" }))).toEqual({ className: "missing", label: "缺失" });
    expect(traceCell(run({ cardCount: 0, traceStatus: "missing" }))).toEqual({ className: "empty", label: "无卡片" });
    expect(traceCell(run({ traceStatus: "unknown" as RunSummary["traceStatus"] }))).toEqual({
      className: "neutral",
      label: "未知",
    });
  });

  it("keeps evaluator gaps and pending reviews filterable", () => {
    const gapRun = run({ avgEvaluatorOverall: 9.2, avgReviewerReward: 5.5, reviewedCount: 8 });
    const pendingRun = run({ reviewedCount: 3, cardCount: 8, avgEvaluatorOverall: 7, avgReviewerReward: 7 });

    expect(evaluatorGap(gapRun)).toBeCloseTo(3.7);
    expect(evaluatorGapMagnitude(gapRun)).toBeCloseTo(3.7);
    expect(runMatchesFocus(gapRun, "eval_gap")).toBe(true);
    expect(remainingReviews(pendingRun)).toBe(5);
    expect(runMatchesFocus(pendingRun, "needs_review")).toBe(true);
  });

  it("treats evaluator underestimates as filterable gaps too", () => {
    const underestimated = run({ avgEvaluatorOverall: 4, avgReviewerReward: 8, reviewedCount: 8 });

    expect(evaluatorGap(underestimated)).toBe(-4);
    expect(evaluatorGapMagnitude(underestimated)).toBe(4);
    expect(runMatchesFocus(underestimated, "eval_gap")).toBe(true);
  });

  it("keeps trace gaps, empty completed runs, and casebook rows filterable", () => {
    const traceMissing = run({ traceStatus: "missing" });
    const emptyCompleted = run({ cardCount: 0, reviewedCount: 0 });
    const casebookRun = run({ casebookCount: 2 });

    expect(runMatchesFocus(traceMissing, "trace_missing")).toBe(true);
    expect(runMatchesFocus(emptyCompleted, "empty_results")).toBe(true);
    expect(runMatchesFocus(casebookRun, "has_cases")).toBe(true);
  });

  it("summarizes the visible workbench workload for the command panel", () => {
    expect(runsWorkloadSummary([
      run({ cardCount: 4, reviewedCount: 1, avgEvaluatorOverall: 9, avgReviewerReward: 5, traceStatus: "missing" }),
      run({ cardCount: 0, reviewedCount: 0, status: "completed" }),
      run({ cardCount: 2, reviewedCount: 2, casebookCount: 1 }),
      agentRunToSummary(activeRun()),
    ])).toEqual({
      casebookRuns: 1,
      emptyRuns: 1,
      evaluatorGapRuns: 1,
      inProgressRuns: 1,
      pendingReviews: 3,
      reviewRuns: 1,
      traceMissingRuns: 1,
    });
  });

  it("prioritizes pending human review over background generation", () => {
    expect(primaryWorkloadAction({
      casebookRuns: 0,
      emptyRuns: 0,
      evaluatorGapRuns: 0,
      inProgressRuns: 1,
      pendingReviews: 466,
      reviewRuns: 14,
      traceMissingRuns: 0,
    })).toEqual({
      label: "先评最新卡片",
      detail: "14 个批次还有 466 张卡没人工判断，另有 1 个生成任务在跑。",
    });
  });

  it("formats progress and visible signal text for the workbench", () => {
    const highlighted = run({
      avgEvaluatorOverall: 9,
      avgReviewerReward: 5,
      deadCardRate: 0.25,
      ahaRate: 0.5,
      casebookCount: 3,
      reviewedCount: 2,
    });

    expect(reviewPercent(highlighted)).toBe(25);
    expect(signalText(highlighted)).toContain("评估分比人工/用户高 4.0");
    expect(signalText(highlighted)).toContain("25% 废卡");
    expect(signalText(highlighted)).toContain("50% AHA");
    expect(signalText(highlighted)).toContain("3 个样本");
  });

  it("ignores non-finite quality rates in visible signal text", () => {
    const highlighted = run({
      deadCardRate: Number.POSITIVE_INFINITY,
      ahaRate: Number.NaN,
    });
    const text = signalText(highlighted);

    expect(text).not.toContain("废卡");
    expect(text).not.toContain("AHA");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");
  });

  it("ignores out-of-range quality rates in visible signal text", () => {
    const highlighted = run({
      deadCardRate: -0.1,
      ahaRate: 1.1,
    });
    const text = signalText(highlighted);

    expect(text).not.toContain("废卡");
    expect(text).not.toContain("AHA");
    expect(text).not.toContain("110%");
  });

  it("clamps invalid backend counts before progress and priority math", () => {
    const invalidCounts = run({
      cardCount: Number.NaN,
      reviewedCount: Number.POSITIVE_INFINITY,
      casebookCount: -2,
      traceStatus: "missing",
    });
    const overReviewed = run({ cardCount: 3, reviewedCount: 9 });

    expect(reviewPercent(invalidCounts)).toBe(0);
    expect(remainingReviews(invalidCounts)).toBe(0);
    expect(runMatchesFocus(invalidCounts, "trace_missing")).toBe(false);
    expect(runMatchesFocus(invalidCounts, "has_cases")).toBe(false);
    expect(reviewPercent(overReviewed)).toBe(100);
    expect(remainingReviews(overReviewed)).toBe(0);
  });

  it("explains evaluator underestimates in the visible workbench signal", () => {
    const underestimated = run({ avgEvaluatorOverall: 3, avgReviewerReward: 7, reviewedCount: 8 });

    expect(signalText(underestimated)).toContain("评估分比人工/用户低 4.0");
  });

  it("prefers persisted generation runs over just-finished active task placeholders", () => {
    const activeSummary = agentRunToSummary(activeRun({ id: "gen.abc", status: "succeeded" }));
    const persisted = run({ id: "run_pk_1", runId: "gen.abc", cardCount: 5, reviewedCount: 0 });

    expect(mergeActiveAndPersistedRuns([activeSummary], [persisted])).toEqual([persisted]);
  });

  it("keeps unresolved active generator tasks visible before persisted runs", () => {
    const activeSummary = agentRunToSummary(activeRun({ id: "gen.pending" }));
    const persisted = run({ id: "run_pk_1", runId: "gen.done" });

    expect(mergeActiveAndPersistedRuns([activeSummary], [persisted])).toEqual([activeSummary, persisted]);
  });

  it("blocks the workbench only when the initial persisted run load fails", () => {
    expect(runsBlockingError("service unavailable", 0)).toBe(true);
    expect(runsBlockingError("service unavailable", 1)).toBe(false);
    expect(runsBlockingError("service unavailable", 3, "same", "same")).toBe(false);
    expect(runsBlockingError(null, 0)).toBe(false);
    expect(runsBlockingError(
      "完成时间开始日期不能晚于结束日期。",
      0,
      "new-filters",
      null,
      "完成时间开始日期不能晚于结束日期。",
    )).toBe(false);
  });

  it("keeps controls visible when changed filters fail after a previous load", () => {
    expect(runsBlockingError("service unavailable", 3, "new-filters", "old-filters")).toBe(false);
  });

  it("hides stale persisted runs as soon as the visible query changes", () => {
    expect(runsHideStaleRows("new-filters", "old-filters")).toBe(true);
    expect(runsHideStaleRows("same", "same")).toBe(false);
    expect(runsHideStaleRows("new-filters", null)).toBe(false);
  });

  it("uses whole-page loading only before the first successful run query", () => {
    expect(runsInitialLoading(true, null)).toBe(true);
    expect(runsInitialLoading(true, null, 1)).toBe(false);
    expect(runsInitialLoading(true, "old-filters")).toBe(false);
    expect(runsInitialLoading(false, null)).toBe(false);
  });

  it("distinguishes loading, failed, and genuinely empty run table states", () => {
    expect(runsTableEmptyMessage(true, false)).toBe("正在读取当前筛选下的生成批次。");
    expect(runsTableEmptyMessage(false, true)).toBe("当前筛选加载失败，请调整筛选后重试。");
    expect(runsTableEmptyMessage(false, false)).toBe("当前筛选条件下没有批次。");
    expect(runsTableEmptyMessage(false, true, "完成时间开始日期不能晚于结束日期。")).toBe("当前筛选条件无效，请先修正。");
  });

  it("reports reversed completed-at filters before requesting a misleading empty table", () => {
    expect(runsFilterError({ since: "2026-05-15", until: "2026-05-14" })).toBe("完成时间开始日期不能晚于结束日期。");
    expect(runsFilterError({ since: "2026-05-14", until: "2026-05-15" })).toBeNull();
  });

  it("reports oversized trigger filters before requesting a misleading unfiltered table", () => {
    expect(runsFilterError({
      since: "",
      trigger: "x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1),
      until: "",
    })).toBe(`触发来源不能超过 ${REWARD_TEXT_FILTER_MAX_LENGTH} 个字符。`);
  });

  it("compares applied run filters before deciding whether search has changes", () => {
    expect(runsQueryEquals(
      { quality: "", reviewed: "", since: "", trigger: "", until: "" },
      { quality: "", reviewed: "", since: "", trigger: "", until: "" },
    )).toBe(true);
    expect(runsQueryEquals(
      { quality: "", reviewed: "", since: "2026-05-14", trigger: "", until: "" },
      { quality: "", reviewed: "", since: "", trigger: "", until: "" },
    )).toBe(false);
  });

  it("keeps stale persisted runs visible after refresh failures", () => {
    expect(runsRefreshErrorText("service unavailable", 3, "same", "same")).toBe(
      "生成批次刷新失败，当前仍显示上一次成功加载的数据：service unavailable",
    );
    expect(runsRefreshErrorText("service unavailable", 0)).toBeNull();
    expect(runsRefreshErrorText("service unavailable", 0, "same", "same")).toBe(
      "生成批次刷新失败，当前仍显示上一次成功加载的数据：service unavailable",
    );
    expect(runsRefreshErrorText("service unavailable", 3, "new-filters", "old-filters")).toBe(
      "生成批次刷新失败，当前筛选还没有成功加载结果：service unavailable",
    );
  });
});
