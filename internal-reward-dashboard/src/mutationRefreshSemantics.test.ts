import { describe, expect, it } from "vitest";

const routeSources = import.meta.glob("./routes/{CardView,CasebookView,RunDetailView,TraceView}.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("post-mutation refresh semantics", () => {
  it("bubbles score refresh failures back to the user-facing mutation status", () => {
    expect(routeSources["./routes/CardView.tsx"]).toContain("await load({ bubbleError: true });");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("await load({ bubbleError: true });");
  });

  it("bubbles casebook save refresh failures back to the editor status", () => {
    expect(routeSources["./routes/CardView.tsx"]).toContain("await load({ bubbleError: true });");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("await load({ bubbleError: true });");
  });

  it("bubbles casebook delete refresh failures back to the local table status", () => {
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("await load({ bubbleError: true });");
  });

  it("treats superseded post-mutation refresh requests as failed refreshes", () => {
    expect(routeSources["./routes/CardView.tsx"]).toContain("throw staleMutationRefreshError()");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("throw staleMutationRefreshError()");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("throw staleMutationRefreshError()");
  });

  it("prevents stale mutation refreshes from crossing detail routes", () => {
    expect(routeSources["./routes/CardView.tsx"]).toContain("const activeCardRouteRef = useRef(cardId)");
    expect(routeSources["./routes/CardView.tsx"]).toContain("activeCardRouteRef.current = cardId");
    expect(routeSources["./routes/CardView.tsx"]).toContain("activeCardRouteRef.current !== routeCardId");
    expect(routeSources["./routes/CardView.tsx"]).toContain("activeCardRouteRef.current !== cardId");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("const activeRunRouteRef = useRef(runId)");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("activeRunRouteRef.current = runId");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("activeRunRouteRef.current !== routeRunId");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("activeRunRouteRef.current !== runId");
  });

  it("prevents stale casebook mutation refreshes from crossing query changes", () => {
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("const activeCasebookQueryKeyRef = useRef(currentQueryKey)");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("activeCasebookQueryKeyRef.current = currentQueryKey");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("requestQueryKey !== activeCasebookQueryKeyRef.current");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("const mutationQueryKey = currentQueryKey");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("activeCasebookQueryKeyRef.current !== mutationQueryKey");
  });

  it("prevents stale trace rebuilds from crossing run routes", () => {
    expect(routeSources["./routes/TraceView.tsx"]).toContain("const activeTraceRouteRef = useRef(runId)");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("activeTraceRouteRef.current = runId");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("const routeRunId = runId");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("routeRunId !== activeTraceRouteRef.current");
    expect(routeSources["./routes/TraceView.tsx"]).toContain("buildTrace(routeRunId, force)");
  });

  it("guards score and casebook mutations when card ids are missing", () => {
    expect(routeSources["./routes/CardView.tsx"]).toContain("const cardMutationId = firstDashboardRouteId(detail.card.id, cardId)");
    expect(routeSources["./routes/CardView.tsx"]).toContain("scoreCard(cardMutationId, score)");
    expect(routeSources["./routes/CardView.tsx"]).toContain("disabledReason={!canMutateCard ? \"当前卡片缺少 ID，不能保存人工评分。\" : undefined}");
    expect(routeSources["./routes/CardView.tsx"]).toContain("disabled={!canMutateCard}");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("saveScore(cardMutationId, score)");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("disabledReason={!canMutateCard ? \"当前卡片缺少 ID，不能保存人工评分。\" : undefined}");
    expect(routeSources["./routes/RunDetailView.tsx"]).toContain("disabled={!canMutateCard}");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain("当前样本缺少卡片 ID，不能移除。");
  });
});
