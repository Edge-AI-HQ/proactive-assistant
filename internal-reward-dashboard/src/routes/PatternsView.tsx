import { useEffect, useMemo, useState } from "react";
import { Activity, Brain, Inbox, RefreshCw, Trash2 } from "lucide-react";
import { listPatterns } from "@/api/reward";
import type {
  PatternListResponse,
  PatternStatus,
  PatternSummary,
  PatternSurpriseLevel,
  PatternTier,
} from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRoutes } from "@/lib/dashboardRoutes";

interface PatternsViewProps {
  onNavigate: (path: string) => void;
}

type StatusFilter = PatternStatus | "";
type SurpriseFilter = PatternSurpriseLevel | "";
type TierFilter = PatternTier | "";

interface PatternsQueryState {
  category: string;
  intent: string;
  status: StatusFilter;
  surprise: SurpriseFilter;
  tier: TierFilter;
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "active", label: "active" },
  { value: "pending_review", label: "pending_review" },
  { value: "retired", label: "retired" },
];

const SURPRISE_OPTIONS: Array<{ value: SurpriseFilter; label: string }> = [
  { value: "", label: "全部 surprise" },
  { value: "h", label: "h · 高" },
  { value: "m", label: "m · 中" },
  { value: "l", label: "l · 低" },
];

const TIER_OPTIONS: Array<{ value: TierFilter; label: string }> = [
  { value: "", label: "全部 tier" },
  { value: "cold_start_friendly", label: "cold_start_friendly" },
  { value: "warmup", label: "warmup" },
  { value: "mature", label: "mature" },
];

function surpriseLabel(value: PatternSurpriseLevel | null): string {
  if (value === "h") return "h";
  if (value === "m") return "m";
  if (value === "l") return "l";
  return "—";
}

function sourceDataText(pattern: PatternSummary): string {
  if (pattern.demoSourceDataSummary.length > 0) {
    return pattern.demoSourceDataSummary.join(" + ");
  }
  const signals = pattern.signalsRequired.slice(0, 4).join(" + ");
  return signals || "—";
}

export function PatternsView({ onNavigate }: PatternsViewProps) {
  const [query, setQuery] = useState<PatternsQueryState>({
    category: "",
    intent: "",
    status: "",
    surprise: "",
    tier: "",
  });
  const [data, setData] = useState<PatternListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPatterns({
      category: query.category.trim() || undefined,
      intent: query.intent.trim() || undefined,
      status: query.status || undefined,
      surprise: query.surprise || undefined,
      tier: query.tier || undefined,
      limit: 500,
    })
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const facets = data?.facets ?? { categories: [], intents: [] };
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const categoryOptions = useMemo(() => {
    return [{ value: "", label: "全部分类" }, ...facets.categories.map((c) => ({ value: c, label: c }))];
  }, [facets.categories]);
  const intentOptions = useMemo(() => {
    return [{ value: "", label: "全部 intent" }, ...facets.intents.map((c) => ({ value: c, label: c }))];
  }, [facets.intents]);

  function update<K extends keyof PatternsQueryState>(key: K, value: PatternsQueryState[K]) {
    setQuery((q) => ({ ...q, [key]: value }));
  }

  function reset() {
    setQuery({ category: "", intent: "", status: "", surprise: "", tier: "" });
  }

  return (
    <div className="stack">
      <section className="panel" aria-label="认知范式库">
        <div className="panel-head">
          <div>
            <div className="eyebrow">
              <Brain size={14} aria-hidden="true" /> Pattern Library v0
            </div>
            <h2 data-testid="patterns-total">
              {loading ? "加载中…" : `${total} 条 abstract pattern`}
            </h2>
            <p>每条 pattern 描述一类用户认知/行为模式。点击一行进入详情。</p>
          </div>
          <div className="toolbar-actions">
            <button
              className="plain-button"
              type="button"
              onClick={() => onNavigate(dashboardRoutes.patternsPending)}
              data-testid="goto-pending"
            >
              <Inbox size={14} aria-hidden="true" />
              <span>待审批</span>
            </button>
            <button
              className="plain-button"
              type="button"
              onClick={() => onNavigate(dashboardRoutes.patternsHealth)}
              data-testid="goto-health"
            >
              <Activity size={14} aria-hidden="true" />
              <span>健康监控</span>
            </button>
            <button
              className="plain-button"
              type="button"
              onClick={() => onNavigate(dashboardRoutes.patternsRetired)}
              data-testid="goto-retired"
            >
              <Trash2 size={14} aria-hidden="true" />
              <span>退役范式</span>
            </button>
            <button className="plain-button" onClick={reset} type="button">
              <RefreshCw size={14} aria-hidden="true" />
              <span>重置筛选</span>
            </button>
          </div>
        </div>
        <div className="patterns-filter-row" role="search" aria-label="范式筛选">
          <label className="patterns-filter-field">
            <span>分类</span>
            <select
              aria-label="按分类筛选 pattern"
              value={query.category}
              onChange={(e) => update("category", e.target.value)}
              data-testid="patterns-filter-category"
            >
              {categoryOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="patterns-filter-field">
            <span>状态</span>
            <select
              aria-label="按 status 筛选 pattern"
              value={query.status}
              onChange={(e) => update("status", e.target.value as StatusFilter)}
              data-testid="patterns-filter-status"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="patterns-filter-field">
            <span>Surprise</span>
            <select
              aria-label="按 surprise 级别筛选 pattern"
              value={query.surprise}
              onChange={(e) => update("surprise", e.target.value as SurpriseFilter)}
              data-testid="patterns-filter-surprise"
            >
              {SURPRISE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="patterns-filter-field">
            <span>Tier</span>
            <select
              aria-label="按 tier 筛选 pattern"
              value={query.tier}
              onChange={(e) => update("tier", e.target.value as TierFilter)}
              data-testid="patterns-filter-tier"
            >
              {TIER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="patterns-filter-field">
            <span>Intent</span>
            <select
              aria-label="按 intent 筛选 pattern"
              value={query.intent}
              onChange={(e) => update("intent", e.target.value)}
              data-testid="patterns-filter-intent"
            >
              {intentOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {error && <StateBlock title="加载失败" detail={error} />}
      {!error && loading && <StateBlock title="加载中…" />}
      {!error && !loading && items.length === 0 && (
        <StateBlock
          title="没有符合条件的 pattern"
          detail="尝试调整筛选条件或点击重置。"
        />
      )}

      {!error && !loading && items.length > 0 && (
        <section className="panel" aria-label="范式列表">
          <div className="table-wrap">
            <table aria-label="范式列表" className="patterns-table">
              <thead>
                <tr>
                  <th scope="col">卡片标题</th>
                  <th scope="col">卡片分类</th>
                  <th scope="col">人性需求</th>
                  <th scope="col">具体入口</th>
                  <th scope="col">人性洞察</th>
                  <th scope="col">来源数据</th>
                  <th scope="col">Abstract</th>
                  <th scope="col">ID</th>
                  <th scope="col">分类</th>
                  <th scope="col">Intent</th>
                  <th scope="col">Tier</th>
                  <th scope="col">S</th>
                  <th scope="col">P</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p: PatternSummary) => (
                  <tr
                    key={p.id}
                    className="patterns-row"
                    data-testid={`patterns-row-${p.id}`}
                    onClick={() => onNavigate(dashboardRoutes.pattern(p.id))}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onNavigate(dashboardRoutes.pattern(p.id));
                      }
                    }}
                  >
                    <td className="patterns-demo-title">{p.demoTitle ?? "—"}</td>
                    <td className="patterns-card-category">{p.demoCardCategory ?? "—"}</td>
                    <td className="patterns-human-need">{p.demoHumanNeed ?? "—"}</td>
                    <td className="patterns-entry-point">{p.demoEntryPoint ?? "—"}</td>
                    <td className="patterns-human-insight">{p.humanInsight || "—"}</td>
                    <td className="patterns-source-data">{sourceDataText(p)}</td>
                    <td className="patterns-abstract">{p.abstract}</td>
                    <td><code>{p.id}</code></td>
                    <td>{p.category}</td>
                    <td>{p.intent}</td>
                    <td>{p.tier}</td>
                    <td>{surpriseLabel(p.surpriseInit)}</td>
                    <td>{surpriseLabel(p.practicalInit)}</td>
                    <td>{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

export default PatternsView;
