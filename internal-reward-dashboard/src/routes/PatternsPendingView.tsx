import { useEffect, useState } from "react";
import { Brain, Check, X } from "lucide-react";
import {
  approvePendingPattern,
  listPendingPatterns,
  rejectPendingPattern,
} from "@/api/reward";
import type { PatternSummary } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRoutes } from "@/lib/dashboardRoutes";

interface PatternsPendingViewProps {
  onNavigate: (path: string) => void;
}

export function PatternsPendingView({ onNavigate }: PatternsPendingViewProps) {
  const [items, setItems] = useState<PatternSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function refresh() {
    setLoading(true);
    setError(null);
    listPendingPatterns()
      .then((res) => setItems(res.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function approve(p: PatternSummary) {
    setBusy(p.id);
    try {
      await approvePendingPattern(p.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function reject(p: PatternSummary) {
    setBusy(p.id);
    try {
      await rejectPendingPattern(p.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <section className="panel" aria-label="待审批的认知范式">
        <div className="panel-head">
          <div>
            <div className="eyebrow">
              <Brain size={14} aria-hidden="true" /> Pending Review
            </div>
            <h2 data-testid="patterns-pending-count">
              {loading ? "加载中…" : `${items.length} 条候选范式`}
            </h2>
            <p>AI 抽取出的候选，等待 reviewer 审批。通过 → status=active；拒绝 → 删除。</p>
          </div>
          <div className="toolbar-actions">
            <button
              className="plain-button"
              onClick={() => onNavigate(dashboardRoutes.patterns)}
              type="button"
            >
              <span>返回范式库</span>
            </button>
          </div>
        </div>
      </section>

      {error && <StateBlock title="加载失败" detail={error} />}
      {!error && !loading && items.length === 0 && (
        <StateBlock title="暂无待审批" detail="目前没有 AI 抽取的候选范式。" />
      )}

      {items.length > 0 && (
        <section className="panel" aria-label="候选范式列表">
          <ul className="patterns-demo-list">
            {items.map((p) => (
              <li key={p.id} className="patterns-demo">
                <div className="patterns-demo-meta">
                  <strong>{p.id}</strong>
                  <span className="patterns-chip">{p.category}</span>
                  <span className="patterns-chip">intent: {p.intent}</span>
                  <span className="patterns-chip">tier: {p.tier}</span>
                  <span className="patterns-chip">source: {p.source}</span>
                </div>
                <p className="muted">{p.abstract}</p>
                <div className="toolbar-actions">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busy === p.id}
                    aria-label={`通过候选 ${p.id}`}
                    onClick={() => void approve(p)}
                    data-testid={`approve-${p.id}`}
                  >
                    <Check size={14} aria-hidden="true" />
                    <span>通过 → active</span>
                  </button>
                  <button
                    className="plain-button"
                    type="button"
                    disabled={busy === p.id}
                    aria-label={`拒绝候选 ${p.id}`}
                    onClick={() => void reject(p)}
                    data-testid={`reject-${p.id}`}
                  >
                    <X size={14} aria-hidden="true" />
                    <span>拒绝并删除</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default PatternsPendingView;
