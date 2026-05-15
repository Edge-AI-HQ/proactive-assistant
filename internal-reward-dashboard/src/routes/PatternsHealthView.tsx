import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, Play, RefreshCw } from "lucide-react";
import {
  getPatternsHealth,
  runPatternsHealthJob,
} from "@/api/reward";
import type { PatternHealthRow } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRoutes } from "@/lib/dashboardRoutes";

interface PatternsHealthViewProps {
  onNavigate: (path: string) => void;
}

function percent(value: number | null): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

function formatTrend(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(2);
}

export function PatternsHealthView({ onNavigate }: PatternsHealthViewProps) {
  const [items, setItems] = useState<PatternHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState(false);
  const [lastJob, setLastJob] = useState<{ updates: number; retires: number; total: number } | null>(null);

  function refresh() {
    setLoading(true);
    setError(null);
    getPatternsHealth()
      .then((res) => setItems(res.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runJob() {
    setRunningJob(true);
    try {
      const out = await runPatternsHealthJob();
      setLastJob({ updates: out.updates, retires: out.retires, total: out.total });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningJob(false);
    }
  }

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      // declining-trend / should_retire first
      if (a.shouldRetire !== b.shouldRetire) return a.shouldRetire ? -1 : 1;
      const ta = a.hitRate30dTrend ?? 0;
      const tb = b.hitRate30dTrend ?? 0;
      return ta - tb;
    });
  }, [items]);
  const flagged = sorted.filter((r) => r.shouldRetire).length;

  return (
    <div className="stack">
      <section className="panel" aria-label="范式健康监控">
        <div className="panel-head">
          <div>
            <div className="eyebrow">
              <Brain size={14} aria-hidden="true" /> Pattern Health
            </div>
            <h2 data-testid="patterns-health-count">
              {loading ? "加载中…" : `${items.length} 条范式 · ${flagged} 条触发退役阈值`}
            </h2>
            <p>每日跑 hit_rate / dismiss_rate / evaluator-human gap，触发阈值的自动退役。</p>
          </div>
          <div className="toolbar-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => void runJob()}
              disabled={runningJob}
              data-testid="run-health-job"
            >
              <Play size={14} aria-hidden="true" />
              <span>{runningJob ? "运行中…" : "立即运行健康任务"}</span>
            </button>
            <button
              className="plain-button"
              type="button"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>刷新</span>
            </button>
            <button
              className="plain-button"
              type="button"
              onClick={() => onNavigate(dashboardRoutes.patterns)}
            >
              <span>返回范式库</span>
            </button>
          </div>
        </div>
        {lastJob && (
          <p className="muted">
            最近一次健康任务：处理 {lastJob.total} 条，更新 base_hit_rate {lastJob.updates} 条，自动退役 {lastJob.retires} 条。
          </p>
        )}
      </section>

      {error && <StateBlock title="加载失败" detail={error} />}
      {!error && loading && <StateBlock title="加载中…" />}

      {!error && !loading && sorted.length > 0 && (
        <section className="panel" aria-label="健康指标列表">
          <div className="table-wrap">
            <table aria-label="范式健康指标" className="patterns-table">
              <thead>
                <tr>
                  <th scope="col">Pattern</th>
                  <th scope="col">Status</th>
                  <th scope="col">命中 7d</th>
                  <th scope="col">命中 30d</th>
                  <th scope="col">hit_rate_7d</th>
                  <th scope="col">hit_rate_30d</th>
                  <th scope="col">trend</th>
                  <th scope="col">dismiss_30d</th>
                  <th scope="col">eval-gap</th>
                  <th scope="col">退役建议</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.patternId}
                    className="patterns-row"
                    onClick={() => onNavigate(dashboardRoutes.pattern(r.patternId))}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onNavigate(dashboardRoutes.pattern(r.patternId));
                      }
                    }}
                  >
                    <td><code>{r.patternId}</code></td>
                    <td>{r.status}</td>
                    <td>{r.hitCount7d}</td>
                    <td>{r.hitCount30d}</td>
                    <td>{percent(r.hitRate7d)}</td>
                    <td>{percent(r.hitRate30d)}</td>
                    <td>{formatTrend(r.hitRate30dTrend)}</td>
                    <td>{percent(r.dismissRate30d)}</td>
                    <td>{r.evaluatorHumanGapMean !== null ? r.evaluatorHumanGapMean.toFixed(2) : "—"}</td>
                    <td>
                      {r.shouldRetire ? (
                        <span className="patterns-chip patterns-chip-status" data-testid={`retire-${r.patternId}`}>
                          <AlertTriangle size={12} aria-hidden="true" />
                          {r.retireReasons.join(", ")}
                        </span>
                      ) : (
                        <span className="muted">OK</span>
                      )}
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

export default PatternsHealthView;
