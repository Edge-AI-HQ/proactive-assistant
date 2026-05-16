import { useEffect, useState } from "react";
import { Brain, RotateCcw } from "lucide-react";
import { listPatterns, setPatternStatus } from "@/api/reward";
import type { PatternSummary } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRoutes } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";

interface PatternsRetiredViewProps {
  onNavigate: (path: string) => void;
}

export function PatternsRetiredView({ onNavigate }: PatternsRetiredViewProps) {
  const [items, setItems] = useState<PatternSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function refresh() {
    setLoading(true);
    setError(null);
    listPatterns({ status: "retired", limit: 500 })
      .then((res) => setItems(res.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function revive(p: PatternSummary) {
    setBusy(p.id);
    try {
      await setPatternStatus(p.id, "active");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <section className="panel" aria-label="退役范式列表">
        <div className="panel-head">
          <div>
            <div className="eyebrow">
              <Brain size={14} aria-hidden="true" /> Retired Patterns
            </div>
            <h2 data-testid="patterns-retired-count">
              {loading ? "加载中…" : `${items.length} 条退役范式`}
            </h2>
            <p>已退役（自动或手动）。点 "复活" 把 status 切回 active，再次进入匹配。</p>
          </div>
          <div className="toolbar-actions">
            <button
              className="plain-button"
              type="button"
              onClick={() => onNavigate(dashboardRoutes.patterns)}
            >
              <span>返回范式库</span>
            </button>
          </div>
        </div>
      </section>

      {error && <StateBlock title="加载失败" detail={error} />}
      {!error && !loading && items.length === 0 && (
        <StateBlock title="目前没有退役范式" />
      )}

      {!error && !loading && items.length > 0 && (
        <section className="panel" aria-label="退役范式表">
          <div className="table-wrap">
            <table aria-label="退役范式表" className="patterns-table">
              <thead>
                <tr>
                  <th scope="col">Pattern</th>
                  <th scope="col">分类</th>
                  <th scope="col">Intent</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Retired At</th>
                  <th scope="col">动作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="patterns-row">
                    <td><code>{p.id}</code></td>
                    <td>{p.category}</td>
                    <td>{p.intent}</td>
                    <td>{p.tier}</td>
                    <td>{formatDateTimeOrDash(p.retiredAt, { dateStyle: "medium", timeStyle: "short" }, "zh-CN")}</td>
                    <td>
                      <button
                        className="plain-button"
                        type="button"
                        disabled={busy === p.id}
                        onClick={() => void revive(p)}
                        data-testid={`revive-${p.id}`}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                        <span>复活 → active</span>
                      </button>
                    </td>
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

export default PatternsRetiredView;
