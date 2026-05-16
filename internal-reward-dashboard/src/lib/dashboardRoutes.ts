const runsPath = "/runs";
const missingMarkdownLink = "未保存";
type DashboardDynamicRoute = "run" | "card" | "trace" | "pattern";

function routeId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function routeWithId(basePath: string, value: string): string {
  const id = routeId(value);
  return id ? `${basePath}/${encodeURIComponent(id)}` : runsPath;
}

const dynamicRouteBasePaths = {
  card: "/cards",
  run: "/runs",
  trace: "/traces",
  pattern: "/patterns",
} satisfies Record<DashboardDynamicRoute, string>;

export const dashboardRoutes = {
  runs: runsPath,
  casebook: "/casebook",
  personalData: "/personal-data",
  patterns: "/patterns",
  patternsPending: "/patterns/pending",
  patternsHealth: "/patterns/health",
  patternsRetired: "/patterns/retired",
  run: (runId: string) => routeWithId("/runs", runId),
  card: (cardId: string) => routeWithId("/cards", cardId),
  trace: (runId: string) => routeWithId("/traces", runId),
  pattern: (patternId: string) => routeWithId("/patterns", patternId),
} as const;

export function firstDashboardRouteId(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const id = routeId(value);
    if (id) return id;
  }
  return "";
}

export function hasDashboardRouteId(value: string | null | undefined): boolean {
  return routeId(value).length > 0;
}

export function dashboardMarkdownLink(kind: DashboardDynamicRoute, value: string | null | undefined): string {
  const id = routeId(value);
  return id ? `${dynamicRouteBasePaths[kind]}/${encodeURIComponent(id)}` : missingMarkdownLink;
}

export function dashboardDisplayId(...values: Array<string | null | undefined>): string {
  return firstDashboardRouteId(...values) || missingMarkdownLink;
}

export function dashboardRouteDisabledReason(kind: DashboardDynamicRoute): string {
  if (kind === "card") return "缺少卡片 ID，不能打开卡片。";
  if (kind === "trace") return "缺少链路 ID，不能打开生成链路。";
  if (kind === "pattern") return "缺少 Pattern ID，不能打开认知范式详情。";
  return "缺少批次 ID，不能打开批次。";
}

export type DashboardRoute =
  | { kind: "runs" }
  | { kind: "run"; runId: string }
  | { kind: "card"; cardId: string }
  | { kind: "casebook" }
  | { kind: "personal-data" }
  | { kind: "trace"; runId: string }
  | { kind: "patterns" }
  | { kind: "patterns-pending" }
  | { kind: "patterns-health" }
  | { kind: "patterns-retired" }
  | { kind: "pattern"; patternId: string };

function decodeRoutePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseDashboardRoute(pathname: string): DashboardRoute {
  const parts = pathname.split(/[?#]/)[0]?.split("/").filter(Boolean) ?? [];
  const id = parts[1] ? routeId(decodeRoutePart(parts[1])) : "";
  if (parts[0] === "runs" && id) return { kind: "run", runId: id };
  if (parts[0] === "cards" && id) return { kind: "card", cardId: id };
  if (parts[0] === "casebook") return { kind: "casebook" };
  if (parts[0] === "personal-data") return { kind: "personal-data" };
  if (parts[0] === "traces" && id) return { kind: "trace", runId: id };
  if (parts[0] === "patterns") {
    // Reserved subpaths take precedence over the dynamic patternId match.
    if (parts[1] === "pending") return { kind: "patterns-pending" };
    if (parts[1] === "health") return { kind: "patterns-health" };
    if (parts[1] === "retired") return { kind: "patterns-retired" };
    if (id) return { kind: "pattern", patternId: id };
    return { kind: "patterns" };
  }
  return { kind: "runs" };
}

export function shouldPushDashboardPath(currentPath: string, nextPath: string): boolean {
  return currentPath.split(/[?#]/)[0] !== nextPath.split(/[?#]/)[0];
}

function shortRouteId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

export function dashboardRouteTitle(route: DashboardRoute): string {
  if (route.kind === "runs") return "生成批次";
  if (route.kind === "run") return `批次 ${shortRouteId(route.runId)}`;
  if (route.kind === "card") return `卡片 ${shortRouteId(route.cardId)}`;
  if (route.kind === "casebook") return "样本库";
  if (route.kind === "personal-data") return "个人数据";
  if (route.kind === "patterns") return "认知范式库";
  if (route.kind === "patterns-pending") return "范式 · 待审批";
  if (route.kind === "patterns-health") return "范式 · 健康监控";
  if (route.kind === "patterns-retired") return "范式 · 退役";
  if (route.kind === "pattern") return `范式 ${shortRouteId(route.patternId)}`;
  return `生成链路 ${shortRouteId(route.runId)}`;
}

export function dashboardDocumentTitle(route: DashboardRoute): string {
  return `${dashboardRouteTitle(route)} | 卡片评审台`;
}

export function dashboardNavPath(route: DashboardRoute): string {
  if (route.kind === "casebook") return dashboardRoutes.casebook;
  if (route.kind === "personal-data") return dashboardRoutes.personalData;
  if (
    route.kind === "patterns"
    || route.kind === "pattern"
    || route.kind === "patterns-pending"
    || route.kind === "patterns-health"
    || route.kind === "patterns-retired"
  ) return dashboardRoutes.patterns;
  return dashboardRoutes.runs;
}
