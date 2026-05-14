import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  ExternalLink,
  Filter,
  GitBranch,
  MessageSquare,
  Target,
} from "lucide-react";
import { buildTrace, cardTitle, getCard, scoreLabel } from "@/api/reward";
import type { CardDetail, TraceArtifact } from "@/api/reward";
import { CasebookEditor } from "@/components/CasebookEditor";
import { ScoreControl } from "@/components/ScoreControl";
import { StateBlock } from "@/components/StateBlock";
import { scoreCard } from "@/api/reward";

interface CardViewProps {
  cardId: string;
  onNavigate: (path: string) => void;
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function traceStatusLabel(status: string | null | undefined): string {
  return {
    failed: "失败",
    missing: "缺失",
    pending: "生成中",
    ready: "已就绪",
  }[status ?? ""] ?? "未知";
}

function caseLabelText(label: string | null | undefined): string {
  return {
    bad: "坏样本",
    duplicate: "重复",
    generic: "泛化",
    great: "好样本",
    hallucinated: "幻觉",
    mistimed: "时机不对",
    surprising: "惊喜",
    weak_source: "证据弱",
  }[label ?? ""] ?? "未保存";
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function listField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clipText(value: string, limit = 260): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}...`;
}

function sourceKind(source: string): string {
  const normalized = source.toLowerCase();
  if (normalized.startsWith("cards.recent")) return "近期卡片";
  if (normalized.startsWith("feedback[")) return "用户反馈";
  if (normalized.startsWith("goal[")) return "目标";
  if (normalized.startsWith("memory[")) return "记忆";
  if (normalized.startsWith("signal[")) return "信号";
  if (normalized.startsWith("dreaming[")) return "dreaming";
  if (normalized.includes("gmail")) return "邮件";
  if (normalized.includes("calendar") || normalized.includes("gcal")) return "日历";
  return "证据";
}

function sourceKinds(sources: string[]): string[] {
  return Array.from(new Set(sources.map(sourceKind)));
}

function feedbackText(event: Record<string, unknown>, key: string): string {
  const value = event[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "-";
}

function rewardSourceText(value: string): string {
  return {
    reviewer: "人工",
    system: "系统",
    user: "用户",
  }[value] ?? value;
}

function eventTypeText(value: string): string {
  return {
    reviewer_score: "人工评分",
    system_score: "系统评分",
    user_score: "用户评分",
  }[value] ?? value;
}

function cardActions(card: CardDetail["card"]): Array<{ label: string; type: string }> {
  const primary = (card.primaryAction ?? card.primary_action) as { label?: string; type?: string } | undefined;
  const secondary = (card.secondaryActions ?? card.secondary_actions) as unknown;
  const out: Array<{ label: string; type: string }> = [];
  if (primary?.label) out.push({ label: primary.label, type: primary.type ?? "primary" });
  if (Array.isArray(secondary)) {
    for (const item of secondary) {
      if (item && typeof item === "object" && "label" in item) {
        const action = item as { label?: string; type?: string };
        if (action.label) out.push({ label: action.label, type: action.type ?? "secondary" });
      }
    }
  }
  return out;
}

function actionTypeText(type: string): string {
  return type === "primary" ? "主动作" : "次动作";
}

function scoreTone(value: number | null | undefined): "high" | "mid" | "low" | "empty" {
  if (typeof value !== "number" || !Number.isFinite(value)) return "empty";
  if (value >= 8) return "high";
  if (value >= 5.5) return "mid";
  return "low";
}

function scaledCardScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 10 : null;
}

function primaryActionLabel(card: CardDetail["card"]): string {
  const primary = (card.primaryAction ?? card.primary_action) as { label?: string } | undefined;
  return primary?.label ?? "没有保存建议动作。";
}

export function CardView({ cardId, onNavigate }: CardViewProps) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [trace, setTrace] = useState<TraceArtifact | null>(null);
  const [traceAttemptedRun, setTraceAttemptedRun] = useState<string | null>(null);
  const [traceMessage, setTraceMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getCard(cardId);
      setDetail(next);
      setTrace(next.trace);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [cardId]);

  useEffect(() => {
    setDetail(null);
    setTrace(null);
    setTraceAttemptedRun(null);
    setTraceMessage(null);
    void load();
  }, [cardId, load]);

  useEffect(() => {
    const runId = detail?.run.runId;
    if (!runId || traceAttemptedRun === runId || trace?.langsmithUrl) return;
    setTraceAttemptedRun(runId);
    setTraceMessage("正在定位 LangSmith 链路");
    buildTrace(runId, trace?.status === "missing" || trace?.status === "failed")
      .then((result) => {
        setTrace(result.trace);
        setTraceMessage(result.trace.langsmithUrl ? null : result.trace.error ?? "没有找到 LangSmith 链路");
      })
      .catch((err) => {
        setTraceMessage(err instanceof Error ? `链路定位失败：${err.message}` : "链路定位失败");
      });
  }, [detail?.run.runId, trace?.langsmithUrl, trace?.status, traceAttemptedRun]);

  if (error) return <StateBlock title="卡片加载失败" detail={error} />;
  if (!detail) return <StateBlock title="正在加载卡片" />;

  const sources = listField(detail.card.sources);
  const sourceKindLabels = sourceKinds(sources);
  const actions = cardActions(detail.card);
  const metrics = [
    { label: "置信度", value: scaledCardScore(detail.card.confidence) },
    { label: "紧急度", value: scaledCardScore(detail.card.urgency) },
    { label: "重要度", value: scaledCardScore(detail.card.importance) },
  ];
  const dimensions = [
    { label: "相关性", value: detail.evaluation?.dimensions.relevance },
    { label: "可执行性", value: detail.evaluation?.dimensions.actionability },
    { label: "时机清晰度", value: detail.evaluation?.dimensions.whyNowClarity },
    { label: "新鲜度", value: detail.evaluation?.dimensions.novelty },
    { label: "决策压缩", value: detail.evaluation?.dimensions.decisionCompression },
  ];

  return (
    <div className="stack">
      <div className="view-toolbar">
        <button className="plain-button" onClick={() => onNavigate(`/runs/${detail.run.runId}`)}>
          <ArrowLeft size={16} /> 返回批次
        </button>
        <div className="toolbar-actions">
          <button className="plain-button" onClick={() => onNavigate(`/traces/${detail.run.runId}`)}>
            <GitBranch size={16} /> 生成链路
          </button>
          {trace?.langsmithUrl && (
            <a className="plain-button" href={trace.langsmithUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> LangSmith
            </a>
          )}
        </div>
      </div>
      <section className="panel card-detail-hero">
        <div className="panel-head">
          <div>
            <h2>{cardTitle(detail.card)}</h2>
            <p>{detail.card.id}</p>
            <div className="card-meta-line">
              <span>{detail.card.goalBasket ?? detail.card.goal_basket ?? "未知领域"}</span>
              <span>{detail.card.intentKey ?? detail.card.intent_key ?? "无意图"}</span>
              <span>批次 {detail.run.trigger ?? "-"}</span>
              <span>链路{traceStatusLabel(trace?.status)}</span>
            </div>
            {traceMessage && <div className="inline-status">{traceMessage}</div>}
          </div>
          <div className="score-pair compact-score">
            <div><span>用户分</span><strong>{scoreLabel(detail.rewards.userReward)}</strong></div>
            <div><span>人工分</span><strong>{scoreLabel(detail.rewards.reviewerReward)}</strong></div>
            <div><span>评估分</span><strong>{scoreLabel(detail.evaluation?.overall)}</strong></div>
          </div>
        </div>
        <div className="card-detail-layout">
          <div className="card-detail-main">
            <section className="card-snapshot-block">
              <div className="section-kicker">卡片正文</div>
              <h3>{detail.card.summary ? "用户看到的核心判断" : "没有保存摘要"}</h3>
              <p>{detail.card.summary ?? "这张卡没有保存摘要。"}</p>
            </section>

            <div className="card-analysis-grid">
              <section className="analysis-block input">
                <div className="analysis-block-head">
                  <span className="analysis-icon"><Database size={17} /></span>
                  <div>
                    <div className="section-kicker">输入</div>
                    <h3>写卡依据</h3>
                  </div>
                  <strong>{sources.length} 条证据</strong>
                </div>
                <p className="analysis-lead">
                  这张卡主要从 {sourceKindLabels.length > 0 ? sourceKindLabels.join("、") : "保存的上下文"} 里提取依据，再写成面向用户的提醒。
                </p>
                <div className="source-chip-row">
                  {(sourceKindLabels.length > 0 ? sourceKindLabels : ["无来源"]).map((kind) => (
                    <span key={kind}>{kind}</span>
                  ))}
                </div>
                <div className="evidence-list refined">
                  {sources.slice(0, 6).map((source, index) => (
                    <article className="evidence-row" key={`${index}:${source}`}>
                      <span>{sourceKind(source)}</span>
                      <p>{clipText(source, 320)}</p>
                    </article>
                  ))}
                  {sources.length === 0 && <div className="muted">没有卡片证据。</div>}
                </div>
              </section>

              <section className="analysis-block decision">
                <div className="analysis-block-head">
                  <span className="analysis-icon"><Filter size={17} /></span>
                  <div>
                    <div className="section-kicker">决策</div>
                    <h3>为什么这样写</h3>
                  </div>
                  <strong>{detail.evaluation ? (detail.evaluation.pass ? "通过" : "未通过") : "待确认"}</strong>
                </div>
                <div className="decision-stack">
                  <div className="decision-item emphasis">
                    <span>为什么现在</span>
                    <p>{detail.card.whyNow ?? detail.card.why_now ?? "没有保存时机说明。"}</p>
                  </div>
                  <div className="decision-item">
                    <span>建议动作</span>
                    <strong>{primaryActionLabel(detail.card)}</strong>
                  </div>
                  {actions.length > 0 && (
                    <div className="action-list refined">
                      {actions.map((action) => (
                        <span key={`${action.type}:${action.label}`}>{actionTypeText(action.type)}：{action.label}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="metric-mini-grid card-signal-grid">
                  {metrics.map((metric) => (
                    <div className={`metric-mini tone-${scoreTone(metric.value)}`} key={metric.label}>
                      <span>{metric.label}</span>
                      <strong>{scoreLabel(metric.value)}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
          <aside className="review-rail card-review-rail">
            <div className="rail-title">
              <Target size={17} />
              <h3>人工评分</h3>
            </div>
            <ScoreControl
              current={detail.rewards.reviewerReward}
              onScore={(score) => scoreCard(detail.card.id, score).then(load)}
            />
            <CasebookEditor
              cardId={detail.card.id}
              initialLabel={detail.casebook?.label ?? "great"}
              initialNote={detail.casebook?.reviewerNote}
              onSaved={load}
            />
            <div className="run-context">
              <div><span>批次开始</span><strong>{formatDate(detail.run.startedAt)}</strong></div>
              <div><span>批次完成</span><strong>{formatDate(detail.run.completedAt)}</strong></div>
              <div><span>样本库</span><strong>{caseLabelText(detail.casebook?.label)}</strong></div>
            </div>
          </aside>
        </div>
      </section>
      <section className="panel evaluator-panel">
        <div className="panel-head">
          <div>
            <h2>评估器判断</h2>
            <p>模型评估器对这张卡的逐项判断。</p>
          </div>
          <span className={`status-pill ${detail.evaluation?.pass ? "ready" : "failed"}`}>
            {detail.evaluation?.pass ? "通过" : "未通过"}
          </span>
        </div>
        <div className="dimension-grid">
          {dimensions.map((dimension) => (
            <div className={`dimension-cell tone-${scoreTone(dimension.value)}`} key={dimension.label}>
              <span>{dimension.label}</span>
              <strong>{scoreLabel(dimension.value)}</strong>
            </div>
          ))}
        </div>
        <div className="evaluation-text spacious">
          <CheckCircle2 size={15} />
          <span>{detail.evaluation?.feedback ?? "没有评估器反馈。"}</span>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>奖励事件历史</h2>
            <p>用户、人工、系统的打分事件，按时间倒序排列。</p>
          </div>
        </div>
        <div className="timeline">
          {detail.rewardHistory.map((event) => (
            <div className="timeline-item" key={event.id}>
              <strong>{rewardSourceText(event.source)} / {eventTypeText(event.eventType)}</strong>
              <span>{scoreLabel(event.score)}</span>
              <span>{new Date(event.createdAt).toLocaleString()}</span>
              {event.reason && <p>{event.reason}</p>}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>产品反馈事件</h2>
            <p>按卡片 ID 合并关闭、稍后、确认、聊天等用户反馈。</p>
          </div>
          <MessageSquare size={18} />
        </div>
        <div className="feedback-event-list">
          {detail.feedbackEvents.map((event) => (
            <div className="feedback-event" key={feedbackText(event, "id")}>
              <div>
                <strong>{feedbackText(event, "kind")} / {feedbackText(event, "action")}</strong>
                <span>{formatDate(textField(event.createdAt))}</span>
              </div>
              <p>{feedbackText(event, "text")}</p>
              <div className="card-meta-line">
                <span>{feedbackText(event, "source")}</span>
                <span>{feedbackText(event, "basket")}</span>
                <span>{feedbackText(event, "channel")}</span>
              </div>
            </div>
          ))}
          {detail.feedbackEvents.length === 0 && <div className="muted">这张卡还没有产品反馈事件。</div>}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>相关意图历史</h2>
            <p>同一个意图下更早出现过的卡片。</p>
          </div>
        </div>
        <div className="related-list">
          {detail.relatedCards.map((related) => (
            <button
              className="related-item"
              key={`${related.runId}:${related.card.id}`}
              onClick={() => onNavigate(`/cards/${related.card.id}`)}
            >
              <strong>{cardTitle(related.card)}</strong>
              <span>{related.completedAt ? new Date(related.completedAt).toLocaleString() : related.runId}</span>
            </button>
          ))}
          {detail.relatedCards.length === 0 && <div className="muted">没有相关卡片。</div>}
        </div>
      </section>
      <section className="panel compact">
        <details className="raw-details">
          <summary>原始卡片数据</summary>
          <pre className="json-block">{JSON.stringify(detail.card, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
