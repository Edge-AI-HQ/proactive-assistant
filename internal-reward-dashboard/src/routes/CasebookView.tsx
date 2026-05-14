import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Trash2 } from "lucide-react";
import {
  casebookMarkdown,
  cardTitle,
  deleteCasebook,
  listCasebook,
  scoreLabel,
} from "@/api/reward";
import type { CasebookEntry } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";

interface CasebookViewProps {
  onNavigate: (path: string) => void;
}

function caseGap(item: CasebookEntry): number | null {
  const evaluatorScore = item.snapshot.evaluation?.overall;
  const humanScore = item.scoreSnapshot ?? item.snapshot.rewards?.reviewerReward ?? item.snapshot.rewards?.userReward;
  if (typeof evaluatorScore !== "number" || typeof humanScore !== "number") return null;
  return evaluatorScore - humanScore;
}

function compactDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function firstSource(item: CasebookEntry): string {
  const sources = item.snapshot.sources ?? item.snapshot.card?.sources ?? [];
  const first = sources.find((source) => typeof source === "string" && source.trim());
  return first ? first.replace(/\s+/g, " ").slice(0, 180) : "没有保存证据引用。";
}

const caseLabelText: Record<string, string> = {
  great: "好样本",
  bad: "坏样本",
  surprising: "惊喜",
  generic: "泛化",
  hallucinated: "幻觉",
  duplicate: "重复",
  mistimed: "时机不对",
  weak_source: "证据弱",
};

const negativeLabels = new Set(["bad", "generic", "hallucinated", "duplicate", "mistimed", "weak_source"]);
const pageSizeOptions = [20, 40, 80];

function gapLabel(value: number | null): string {
  if (value === null) return "-";
  const text = scoreLabel(value);
  return value > 0 ? `+${text}` : text;
}

export function CasebookView({ onNavigate }: CasebookViewProps) {
  const [items, setItems] = useState<CasebookEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [label, setLabel] = useState("");
  const [minScore, setMinScore] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [basket, setBasket] = useState("");
  const [intent, setIntent] = useState("");
  const [minEvaluatorGap, setMinEvaluatorGap] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const offset = (page - 1) * pageSize;

  async function load() {
    try {
      setLoading(true);
      const next = await listCasebook({
        label: label || undefined,
        minScore: minScore ? Number(minScore) : undefined,
        maxScore: maxScore ? Number(maxScore) : undefined,
        basket: basket || undefined,
        intent: intent || undefined,
        minEvaluatorGap: minEvaluatorGap ? Number(minEvaluatorGap) : undefined,
        since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
        until: until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
        limit: pageSize,
        offset,
      });
      setItems(next.items);
      setTotal(next.total ?? next.items.length);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPage(1);
  }, [label, minScore, maxScore, basket, intent, minEvaluatorGap, since, until, pageSize]);

  useEffect(() => {
    void load();
  }, [label, minScore, maxScore, basket, intent, minEvaluatorGap, since, until, pageSize, offset]);

  const markdown = useMemo(() => casebookMarkdown(items), [items]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  async function removeCase(cardId: string) {
    const ok = window.confirm("确认从样本库移除这张卡片？");
    if (!ok) return;
    await deleteCasebook(cardId);
    await load();
  }

  if (error) return <StateBlock title="样本库加载失败" detail={error} />;

  return (
    <div className="stack casebook-page">
      <section className="panel casebook-control">
        <div className="casebook-title-row">
          <div>
            <h2>样本库（{total.toLocaleString()}）</h2>
            <p>稳定正负样本，用于复盘提示词、评估器和卡片生成质量。</p>
          </div>
          <button className="plain-button" onClick={() => setMarkdownOpen((v) => !v)} type="button">
            <Download size={15} /> 导出当前页
          </button>
        </div>
        <div className="casebook-filter-grid">
          <select value={label} onChange={(event) => setLabel(event.target.value)}>
            <option value="">全部标签</option>
            <option value="great">好样本</option>
            <option value="bad">坏样本</option>
            <option value="surprising">惊喜</option>
            <option value="generic">泛化</option>
            <option value="hallucinated">幻觉</option>
            <option value="duplicate">重复</option>
            <option value="mistimed">时机不对</option>
            <option value="weak_source">证据弱</option>
          </select>
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={minScore}
            onChange={(event) => setMinScore(event.target.value)}
            placeholder="最低分"
          />
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={maxScore}
            onChange={(event) => setMaxScore(event.target.value)}
            placeholder="最高分"
          />
          <input value={basket} onChange={(event) => setBasket(event.target.value)} placeholder="领域" />
          <input value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="意图" />
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={minEvaluatorGap}
            onChange={(event) => setMinEvaluatorGap(event.target.value)}
            placeholder="最小分差"
          />
          <input type="date" value={since} onChange={(event) => setSince(event.target.value)} title="更新时间晚于" />
          <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} title="更新时间早于" />
        </div>
        {markdownOpen && <textarea className="markdown-export" readOnly value={markdown} rows={12} />}
      </section>

      <section className="panel casebook-table-panel">
        <div className="casebook-table-wrap">
          <table className="casebook-table">
            <thead>
              <tr>
                <th>标签</th>
                <th>卡片</th>
                <th>评分</th>
                <th>领域/意图</th>
                <th>证据与备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="casebook-empty-cell">正在读取样本库</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="casebook-empty-cell">当前筛选下没有保存样本。</td>
                </tr>
              ) : (
                items.map((item) => {
                  const card = item.snapshot.card;
                  const evaluation = item.snapshot.evaluation;
                  const gap = caseGap(item);
                  const labelTone = negativeLabels.has(item.label) ? "bad" : "good";
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="casebook-label-cell">
                          <span className={`casebook-label ${labelTone}`}>{caseLabelText[item.label] ?? item.label}</span>
                          <small>{compactDate(item.updatedAt)}</small>
                        </div>
                      </td>
                      <td>
                        <button className="casebook-title-button" onClick={() => onNavigate(`/cards/${item.cardId}`)} type="button">
                          {cardTitle(card)}
                        </button>
                        {card?.summary ? <p className="casebook-summary">{card.summary}</p> : null}
                      </td>
                      <td>
                        <div className="casebook-score-strip">
                          <span>保存 {scoreLabel(item.scoreSnapshot)}</span>
                          <span>评估 {scoreLabel(evaluation?.overall)}</span>
                          <span>分差 {gapLabel(gap)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="casebook-meta-stack">
                          <strong>{card?.goalBasket ?? card?.goal_basket ?? "未知领域"}</strong>
                          <span>{card?.intentKey ?? card?.intent_key ?? "无意图"}</span>
                        </div>
                      </td>
                      <td>
                        <div className="casebook-evidence">
                          <span>{firstSource(item)}</span>
                          <em>{item.reviewerNote ?? "没有评审备注"}</em>
                        </div>
                      </td>
                      <td>
                        <div className="casebook-row-actions">
                          <button className="plain-button" onClick={() => onNavigate(`/cards/${item.cardId}`)} type="button">
                            <ExternalLink size={14} /> 打开
                          </button>
                          <button className="icon-danger-button" onClick={() => void removeCase(item.cardId)} title="从样本库移除" type="button">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="casebook-pagination">
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>{size} 条/页</option>
            ))}
          </select>
          <button disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">
            <ChevronLeft size={16} />
            上一页
          </button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">
            下一页
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
