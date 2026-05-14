import { describe, expect, it } from "vitest";

const routeSources = import.meta.glob("./routes/{CardView,CasebookView,PersonalDataView,RunDetailView,RunsView,TraceView}.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("initial-load recovery semantics", () => {
  it("uses the shared recovery predicate for dead first-load states", () => {
    expect(routeSources["./routes/CardView.tsx"]).toContain("initialLoadRecoveryVisible(error, detail)");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("initialLoadRecoveryVisible(error, detail)");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("initialLoadRecoveryVisible(error, trace)");
  });

  it("keeps card recovery actionable without card detail data", () => {
    const source = routeSources["./routes/CardView.tsx"];

    expect(source).toContain("dashboardRoutes.runs");
    expect(source).toContain("dashboardRoutes.casebook");
    expect(source).toContain("重新加载");
    expect(source).toContain('StateBlock title="卡片加载失败"');
  });

  it("keeps run detail recovery actionable without run detail data", () => {
    const source = routeSources["./routes/RunDetailView.tsx"];

    expect(source).toContain("dashboardRoutes.runs");
    expect(source).toContain("dashboardRoutes.trace(runId)");
    expect(source).toContain("重新加载");
    expect(source).toContain('StateBlock title="批次加载失败"');
  });

  it("keeps trace recovery able to reload or rebuild the artifact", () => {
    const source = routeSources["./routes/TraceView.tsx"];

    expect(source).toContain("dashboardRoutes.run(runId)");
    expect(source).toContain("rebuild(true)");
    expect(source).toContain("重建链路记录");
    expect(source).toContain('StateBlock title="链路加载失败"');
  });

  it("keeps entry pages recoverable when their first request fails", () => {
    expect(routeSources["./routes/RunsView.tsx"]).toContain('StateBlock title="生成批次加载失败"');
    expect(routeSources["./routes/RunsView.tsx"]).toContain("setRefreshNonce((value) => value + 1)");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain('StateBlock title="样本库加载失败"');
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("onClick={refreshCurrentCasebookPage}");
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain('StateBlock title="个人数据加载失败"');
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("onClick={refreshPersonalDataView}");
  });

  it("keeps normal entry pages manually refreshable after local refresh errors", () => {
    expect(routeSources["./routes/RunsView.tsx"]).toContain("刷新批次");
    expect(routeSources["./routes/RunsView.tsx"]).toContain("disabled={loading}");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("刷新样本");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("refreshCurrentCasebookPage");
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("刷新上下文");
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("refreshPersonalDataView");
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("disabled={loading || overviewLoading}");
  });

  it("clears stale local action messages before manual entry-page refreshes", () => {
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("setStatusMessage(null);");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("setPendingDeleteCardId(null);");
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("setCopyMessage(null);");
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("setExpandedId(null);");
  });

  it("keeps loaded review detail pages manually refreshable after mutation refresh failures", () => {
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("refreshRunDetail");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("刷新批次");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("disabled={savingCard !== null}");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain('staleRefreshErrorMessage(error, detail, "批次")');
    expect(routeSources["./routes/CardView.tsx"]).toContain("refreshCardDetail");
    expect(routeSources["./routes/CardView.tsx"]).toContain("刷新卡片");
    expect(routeSources["./routes/CardView.tsx"]).toContain("disabled={savingScore}");
    expect(routeSources["./routes/CardView.tsx"]).toContain('staleRefreshErrorMessage(error, detail, "卡片")');
  });

  it("keeps loaded trace pages manually refreshable without hiding stale trace data", () => {
    expect(routeSources["./routes/TraceView.tsx"]).toContain("traceRef.current");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("链路刷新失败，当前仍显示上一次成功加载的数据");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("refreshTraceView");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("刷新链路");
  });
});
