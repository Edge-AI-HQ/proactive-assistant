import { describe, expect, it } from "vitest";
import {
  dashboardDisplayId,
  dashboardMarkdownLink,
  dashboardDocumentTitle,
  dashboardNavPath,
  dashboardRouteDisabledReason,
  dashboardRouteTitle,
  dashboardRoutes,
  firstDashboardRouteId,
  hasDashboardRouteId,
  parseDashboardRoute,
  shouldPushDashboardPath,
} from "./dashboardRoutes";

describe("dashboardRoutes", () => {
  it("keeps top-level dashboard routes centralized", () => {
    expect(dashboardRoutes.runs).toBe("/runs");
    expect(dashboardRoutes.casebook).toBe("/casebook");
    expect(dashboardRoutes.personalData).toBe("/personal-data");
  });

  it("encodes route ids consistently", () => {
    expect(dashboardRoutes.run("run/id 1")).toBe("/runs/run%2Fid%201");
    expect(dashboardRoutes.card("card/id 1")).toBe("/cards/card%2Fid%201");
    expect(dashboardRoutes.trace("trace/id 1")).toBe("/traces/trace%2Fid%201");
  });

  it("normalizes blank or padded dynamic route ids", () => {
    expect(dashboardRoutes.run("  run_1  ")).toBe("/runs/run_1");
    expect(dashboardRoutes.card("   ")).toBe(dashboardRoutes.runs);
    expect(parseDashboardRoute("/traces/%20%20")).toEqual({ kind: "runs" });
    expect(parseDashboardRoute("/cards/%20card_1%20")).toEqual({ kind: "card", cardId: "card_1" });
  });

  it("marks missing markdown links instead of falling back to runs", () => {
    expect(firstDashboardRouteId("   ", " run_1 ")).toBe("run_1");
    expect(hasDashboardRouteId(" run_1 ")).toBe(true);
    expect(hasDashboardRouteId("   ")).toBe(false);
    expect(dashboardMarkdownLink("card", " card/id 1 ")).toBe("/cards/card%2Fid%201");
    expect(dashboardMarkdownLink("run", "   ")).toBe("未保存");
    expect(dashboardMarkdownLink("trace", null)).toBe("未保存");
    expect(dashboardDisplayId("   ", " run_1 ")).toBe("run_1");
    expect(dashboardDisplayId("   ", null)).toBe("未保存");
  });

  it("explains disabled dynamic routes with concrete missing ids", () => {
    expect(dashboardRouteDisabledReason("card")).toBe("缺少卡片 ID，不能打开卡片。");
    expect(dashboardRouteDisabledReason("run")).toBe("缺少批次 ID，不能打开批次。");
    expect(dashboardRouteDisabledReason("trace")).toBe("缺少链路 ID，不能打开生成链路。");
  });

  it("round-trips generated detail routes through the parser", () => {
    expect(parseDashboardRoute(dashboardRoutes.run("run/id 1"))).toEqual({ kind: "run", runId: "run/id 1" });
    expect(parseDashboardRoute(dashboardRoutes.card("card/id 1"))).toEqual({ kind: "card", cardId: "card/id 1" });
    expect(parseDashboardRoute(dashboardRoutes.trace("trace/id 1"))).toEqual({ kind: "trace", runId: "trace/id 1" });
  });

  it("parses top-level routes and falls back to runs", () => {
    expect(parseDashboardRoute(dashboardRoutes.runs)).toEqual({ kind: "runs" });
    expect(parseDashboardRoute(dashboardRoutes.casebook)).toEqual({ kind: "casebook" });
    expect(parseDashboardRoute(dashboardRoutes.personalData)).toEqual({ kind: "personal-data" });
    expect(parseDashboardRoute("/unknown")).toEqual({ kind: "runs" });
  });

  it("keeps malformed encoded ids from crashing route parsing", () => {
    expect(parseDashboardRoute("/cards/%E0%A4%A")).toEqual({ kind: "card", cardId: "%E0%A4%A" });
  });

  it("names routes for page chrome and browser tabs", () => {
    expect(dashboardRouteTitle({ kind: "runs" })).toBe("生成批次");
    expect(dashboardRouteTitle({ kind: "casebook" })).toBe("样本库");
    expect(dashboardRouteTitle({ kind: "personal-data" })).toBe("个人数据");
    expect(dashboardRouteTitle({ kind: "run", runId: "run_123" })).toBe("批次 run_123");
    expect(dashboardRouteTitle({ kind: "card", cardId: "card_12345678901234567890" })).toBe("卡片 card_1234567890123...");
    expect(dashboardDocumentTitle({ kind: "trace", runId: "root_run_1" })).toBe("生成链路 root_run_1 | 卡片评审台");
  });

  it("maps detail routes back to their sidebar workspace", () => {
    expect(dashboardNavPath({ kind: "runs" })).toBe(dashboardRoutes.runs);
    expect(dashboardNavPath({ kind: "run", runId: "run_123" })).toBe(dashboardRoutes.runs);
    expect(dashboardNavPath({ kind: "card", cardId: "card_123" })).toBe(dashboardRoutes.runs);
    expect(dashboardNavPath({ kind: "trace", runId: "root_run_1" })).toBe(dashboardRoutes.runs);
    expect(dashboardNavPath({ kind: "casebook" })).toBe(dashboardRoutes.casebook);
    expect(dashboardNavPath({ kind: "personal-data" })).toBe(dashboardRoutes.personalData);
  });

  it("avoids duplicate browser history entries for the same dashboard path", () => {
    expect(shouldPushDashboardPath("/runs", "/runs")).toBe(false);
    expect(shouldPushDashboardPath("/runs?focus=review", "/runs")).toBe(false);
    expect(shouldPushDashboardPath("/runs", "/casebook")).toBe(true);
  });
});
