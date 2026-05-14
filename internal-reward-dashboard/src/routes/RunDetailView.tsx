import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  Filter,
  GitBranch,
  Search,
  ShieldCheck,
} from "lucide-react";
import { buildTrace, cardTitle, getRun, scoreCard, scoreLabel } from "@/api/reward";
import type { RunDetail, TraceArtifact } from "@/api/reward";
import { CasebookEditor } from "@/components/CasebookEditor";
import { ScoreControl } from "@/components/ScoreControl";
import { StateBlock } from "@/components/StateBlock";
import {
  TRACE_STAGES,
  cardSummary,
  cardWhyNow,
  clipText,
  firstSentences,
  inferredDataSources,
  primaryActionLabel,
  readableTraceLines,
  sourceLabel,
  sourcePreview,
  stageNodes,
  stageSnippets,
  stringList,
  summarizeSources,
  traceStatusLabel,
} from "@/lib/traceText";
import type { TraceStage } from "@/lib/traceText";

interface RunDetailViewProps {
  runId: string;
  onNavigate: (path: string) => void;
}

function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

type CardFilter = "all" | "unreviewed" | "casebook";
type CardSort = "order" | "evaluator_desc" | "evaluator_gap" | "reviewer_low";

const STAGE_ICONS = {
  "data-collector": Database,
  planner: Filter,
  "card-generator": FileText,
  evaluator: ShieldCheck,
} satisfies Record<TraceStage, typeof Database>;

function scoreGap(entry: RunDetail["cards"][number]): number | null {
  if (typeof entry.evaluation?.overall !== "number") return null;
  const humanScore = entry.rewards.reviewerReward ?? entry.rewards.userReward;
  if (typeof humanScore !== "number") return null;
  return entry.evaluation.overall - humanScore;
}

function cardIndex(entry: RunDetail["cards"][number], cards: RunDetail["cards"]): number {
  return cards.findIndex((candidate) => candidate.card.id === entry.card.id);
}

function sourceKind(source: string): string {
  const normalized = source.toLowerCase();
  if (normalized.startsWith("cards.recent")) return "近期卡片";
  if (normalized.startsWith("feedback[")) return "用户反馈";
  if (normalized.startsWith("goal[")) return "目标";
  if (normalized.startsWith("memory[")) return "记忆";
  if (normalized.startsWith("signal[")) return "信号";
  if (normalized.startsWith("dreaming[")) return "dreaming 状态";
  return "证据";
}

function stageLabel(stage: TraceStage): string {
  return {
    "data-collector": "收集原始数据",
    planner: "规划卡片意图",
    "card-generator": "写成用户卡片",
    evaluator: "评估与落库",
  }[stage];
}

function stageExplanation(stage: TraceStage): string {
  return {
    "data-collector": "拉取画像、记忆、信号、邮件、日历、近期卡片、反馈和外部上下文。",
    planner: "先做去重和反馈约束，再决定哪些意图值得进入本轮。",
    "card-generator": "把计划转成标题、摘要、为什么现在、主动作和证据引用。",
    evaluator: "按相关性、可行动性、时机、novelty、决策压缩度评分，低质卡会被丢弃。",
  }[stage];
}

function generationSummary(detail: RunDetail, trace: TraceArtifact | null, dataSources: string[]): string {
  if (detail.cards.length === 0) {
    return trace?.error
      ? `本轮没有落地卡片。链路记录显示：${trace.error}`
      : "本轮没有落地卡片。需要看链路摘要确认是数据为空、规划器过滤，还是评估器全部未通过。";
  }
  const firstCard = detail.cards[0];
  return `本轮读取 ${summarizeSources(dataSources)}，生成 ${detail.cards.length} 张卡。第一张是「${cardTitle(firstCard.card)}」，评估器给到 ${scoreLabel(firstCard.evaluation?.overall)}。`;
}

function stageHighlights(
  stage: TraceStage,
  detail: RunDetail,
  trace: TraceArtifact | null,
  dataSources: string[],
): string[] {
  const firstCard = detail.cards[0];
  const readable = readableTraceLines(stageSnippets(trace?.summary, stage));
  if (stage === "data-collector") {
    return [
      `输入来源：${summarizeSources(dataSources)}。`,
      `链路事件：${stageNodes(trace?.summary, stage)} 个。`,
    ];
  }
  if (stage === "planner") {
    return [
      readable[0] ?? (firstCard ? `优先选择「${cardTitle(firstCard.card)}」，因为：${firstSentences(cardWhyNow(firstCard.card), 240)}` : "规划器没有留下可展示的卡片计划。"),
    ];
  }
  if (stage === "card-generator") {
    return [
      detail.cards.length > 0 ? `写出 ${detail.cards.length} 张通过落库的卡片。` : "没有卡片进入最终落库。",
      firstCard ? `首张摘要：${firstSentences(cardSummary(firstCard.card), 240)}` : "没有可展示的卡片摘要。",
    ];
  }
  return [
    `平均评估分：${scoreLabel(average(detail.cards.map((entry) => entry.evaluation?.overall)))}。`,
    readable[0] ?? (firstCard?.evaluation?.feedback ? `质量备注：${firstSentences(firstCard.evaluation.feedback, 240)}` : "没有保存评估器反馈。"),
  ];
}

export function RunDetailView({ runId, onNavigate }: RunDetailViewProps) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [trace, setTrace] = useState<TraceArtifact | null>(null);
  const [traceAttemptedRun, setTraceAttemptedRun] = useState<string | null>(null);
  const [traceMessage, setTraceMessage] = useState<string | null>(null);
  const [savingCard, setSavingCard] = useState<string | null>(null);
  const [cardFilter, setCardFilter] = useState<CardFilter>("all");
  const [cardSort, setCardSort] = useState<CardSort>("order");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await getRun(runId);
      setDetail(next);
      setTrace(next.trace);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [runId]);

  useEffect(() => {
    setDetail(null);
    setTrace(null);
    setTraceAttemptedRun(null);
    setTraceMessage(null);
    void load();
  }, [load, runId]);

  useEffect(() => {
    const canonicalRunId = detail?.run.runId;
    if (!canonicalRunId || traceAttemptedRun === canonicalRunId || trace?.langsmithUrl) return;
    setTraceAttemptedRun(canonicalRunId);
    setTraceMessage("正在定位 LangSmith 链路");
    buildTrace(canonicalRunId, trace?.status === "missing" || trace?.status === "failed")
      .then((result) => {
        setTrace(result.trace);
        setTraceMessage(result.trace.langsmithUrl ? null : result.trace.error ?? "没有找到 LangSmith 链路");
      })
      .catch((err) => {
        setTraceMessage(err instanceof Error ? `链路定位失败：${err.message}` : "链路定位失败");
      });
  }, [detail?.run.runId, trace?.langsmithUrl, trace?.status, traceAttemptedRun]);

  async function saveScore(cardId: string, score: number) {
    setSavingCard(cardId);
    try {
      await scoreCard(cardId, score);
      await load();
    } finally {
      setSavingCard(null);
    }
  }

  const reviewedCount = detail?.cards.filter((entry) => entry.rewards.reviewerReward !== null).length ?? 0;
  const reviewedPercent = detail && detail.cards.length > 0
    ? Math.round((reviewedCount / detail.cards.length) * 100)
    : 0;
  const visibleCards = useMemo(() => {
    if (!detail) return [];
    const filtered = detail.cards.filter((entry) => {
      if (cardFilter === "unreviewed") return entry.rewards.reviewerReward === null;
      if (cardFilter === "casebook") return Boolean(entry.casebook);
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (cardSort === "evaluator_desc") {
        return (b.evaluation?.overall ?? -1) - (a.evaluation?.overall ?? -1);
      }
      if (cardSort === "evaluator_gap") {
        return (scoreGap(b) ?? -100) - (scoreGap(a) ?? -100);
      }
      if (cardSort === "reviewer_low") {
        const aScore = a.rewards.reviewerReward ?? Number.POSITIVE_INFINITY;
        const bScore = b.rewards.reviewerReward ?? Number.POSITIVE_INFINITY;
        return aScore - bScore;
      }
      return cardIndex(a, detail.cards) - cardIndex(b, detail.cards);
    });
  }, [cardFilter, cardSort, detail]);

  if (error) return <StateBlock title="批次加载失败" detail={error} />;
  if (!detail) return <StateBlock title="正在加载批次" />;

  const langsmithUrl = trace?.langsmithUrl || (
    typeof trace?.traceTree.langsmithUrl === "string" ? trace.traceTree.langsmithUrl : ""
  );
  const largestGap = detail.cards
    .map((entry) => ({ entry, gap: scoreGap(entry) }))
    .filter((item): item is { entry: RunDetail["cards"][number]; gap: number } => item.gap !== null)
    .sort((a, b) => b.gap - a.gap)[0];
  const lowestEvaluator = [...detail.cards]
    .filter((entry) => typeof entry.evaluation?.overall === "number")
    .sort((a, b) => (a.evaluation?.overall ?? 99) - (b.evaluation?.overall ?? 99))[0];
  const traceDataSources = stringList(trace?.summary.dataSources);
  const dataSources = traceDataSources.length > 0 ? traceDataSources : inferredDataSources(detail);
  const firstCardSources = sourcePreview(detail.cards[0]?.card);

  return (
    <div className="stack">
      <div className="view-toolbar">
        <button className="plain-button" onClick={() => onNavigate("/runs")}>
          <ArrowLeft size={16} /> 批次列表
        </button>
        <div className="toolbar-actions">
          <button className="plain-button" onClick={() => onNavigate(`/traces/${detail.run.runId}`)}>
            <GitBranch size={16} /> 生成链路
          </button>
          {langsmithUrl && (
            <a className="plain-button" href={langsmithUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> LangSmith
            </a>
          )}
        </div>
      </div>
      <section className="panel run-overview">
        <div className="panel-head">
          <div>
            <h2>生成批次</h2>
            <p>
              {detail.run.completedAt ? new Date(detail.run.completedAt).toLocaleString() : "未完成"}
              {" "} / {detail.cards.length} 张卡 / {detail.run.runId}
            </p>
          </div>
          <span className={`status-pill ${trace?.status ?? "missing"}`}>
            {traceStatusLabel(trace?.status)}
          </span>
        </div>
        {traceMessage && <div className="inline-status">{traceMessage}</div>}
        <div className="run-overview-grid">
          <div>
            <span>触发来源</span>
            <strong>{detail.run.trigger ?? "-"}</strong>
          </div>
          <div>
            <span>人工平均分</span>
            <strong>{scoreLabel(
              average(detail.cards.map((entry) => entry.rewards.reviewerReward)),
            )}</strong>
          </div>
          <div>
            <span>评估平均分</span>
            <strong>{scoreLabel(
              average(detail.cards.map((entry) => entry.evaluation?.overall)),
            )}</strong>
          </div>
          <div>
            <span>已保存样本</span>
            <strong>{detail.cards.filter((entry) => entry.casebook).length}</strong>
          </div>
        </div>
      </section>
      <section className="panel generation-process-panel">
        <div className="panel-head">
          <div>
            <h2>生成过程</h2>
            <p>{generationSummary(detail, trace, dataSources)}</p>
          </div>
          <span className={`status-pill ${trace?.status ?? "missing"}`}>
            链路{traceStatusLabel(trace?.status)}
          </span>
        </div>
        <div className="generation-source-row">
          {dataSources.length > 0
            ? dataSources.map((source) => <span key={source}>{sourceLabel(source)}</span>)
            : <span>没有识别到输入来源</span>}
        </div>
        <div className="generation-stage-grid">
          {TRACE_STAGES.map((stage, index) => {
            const StageIcon = STAGE_ICONS[stage];
            const highlights = stageHighlights(stage, detail, trace, dataSources);
            return (
              <article className="generation-stage-card" key={stage}>
                <div className="generation-stage-head">
                  <span><StageIcon size={16} /> 第 {index + 1} 步</span>
                  <strong>{stageLabel(stage)}</strong>
                </div>
                <p>{stageExplanation(stage)}</p>
                <ul>
                  {highlights.map((highlight) => (
                    <li key={highlight}><CheckCircle2 size={14} /> {highlight}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
        <div className="generation-evidence-grid">
          <div>
            <h3>AI 判断摘要</h3>
            <p>{readableTraceLines([
              ...stageSnippets(trace?.summary, "planner"),
              ...stageSnippets(trace?.summary, "evaluator"),
            ])[0] ?? "链路摘要还没有足够可读的 planner/evaluator 文本；可以打开生成链路查看完整节点。"}</p>
          </div>
          <div>
            <h3>原始证据引用</h3>
            <div className="evidence-stack compact">
              {(firstCardSources.length > 0 ? firstCardSources.slice(0, 4) : ["当前批次没有保存卡片证据引用。"]).map((source) => (
                <p key={source}>{clipText(source, 260)}</p>
              ))}
            </div>
          </div>
        </div>
        {trace?.summary && (
          <details className="raw-details compact">
            <summary>查看标准化链路摘要 JSON</summary>
            <pre className="json-block">{JSON.stringify(trace.summary, null, 2)}</pre>
          </details>
        )}
      </section>
      <section className="review-workbar">
        <div className="review-workbar-copy">
          <strong>还剩 {detail.cards.length - reviewedCount} 张待评审</strong>
          <span>{reviewedCount} / {detail.cards.length} 张已评审 · 当前显示 {visibleCards.length} 张</span>
          <div className="review-workbar-progress" aria-label="批次评审进度">
            <div style={{ width: `${reviewedPercent}%` }} />
          </div>
        </div>
        <div className="filter-row">
          <select value={cardFilter} onChange={(event) => setCardFilter(event.target.value as CardFilter)}>
            <option value="all">全部卡片</option>
            <option value="unreviewed">未评审</option>
            <option value="casebook">已入样本库</option>
          </select>
          <select value={cardSort} onChange={(event) => setCardSort(event.target.value as CardSort)}>
            <option value="order">生成顺序</option>
            <option value="evaluator_desc">评估分从高到低</option>
            <option value="evaluator_gap">分差最大优先</option>
            <option value="reviewer_low">人工低分优先</option>
          </select>
        </div>
      </section>
      <section className="review-insight-grid">
        <div>
          <span>最大评估分差</span>
          <strong>{largestGap ? scoreLabel(largestGap.gap) : "-"}</strong>
          <p>{largestGap ? cardTitle(largestGap.entry.card) : "还没有人工分。"}</p>
        </div>
        <div>
          <span>评估分最低卡</span>
          <strong>{lowestEvaluator ? scoreLabel(lowestEvaluator.evaluation?.overall) : "-"}</strong>
          <p>{lowestEvaluator ? cardTitle(lowestEvaluator.card) : "还没有评估记录。"}</p>
        </div>
        <div>
          <span>链路状态</span>
          <strong>{traceStatusLabel(trace?.status)}</strong>
          <p>{trace?.error ?? "生成行为不清楚时，打开链路看具体过程。"}</p>
        </div>
      </section>
      <div className="card-review-list">
        {visibleCards.map((entry) => {
          const index = cardIndex(entry, detail.cards);
          return (
          <section className="review-card generation-card" key={entry.card.id}>
            <div className="review-main">
              <div className="review-card-head">
                <div className="card-meta-line">
                  <span>第 {index + 1} 张</span>
                  <span>{entry.card.goalBasket ?? entry.card.goal_basket ?? "未知领域"}</span>
                  <span>{entry.card.intentKey ?? entry.card.intent_key ?? "无意图"}</span>
                  <span>{(entry.card.sources ?? []).length} 条证据</span>
                  <span>{entry.casebook ? "已保存样本" : "未入样本库"}</span>
                </div>
                <h3>{cardTitle(entry.card)}</h3>
                <p className="card-summary-text">{entry.card.summary ?? "没有保存摘要。"}</p>
              </div>
              <div className="card-decision-grid">
                {primaryActionLabel(entry.card) && (
                  <div className="action-callout">
                    <span>建议动作</span>
                    <strong>{primaryActionLabel(entry.card)}</strong>
                  </div>
                )}
                <div className="why-now-card">
                  <span>为什么现在</span>
                  <p>{entry.card.whyNow ?? entry.card.why_now ?? "没有保存时机说明。"}</p>
                </div>
              </div>
              <div className="source-evidence-preview elevated">
                <span className="section-label">证据引用</span>
                {(entry.card.sources ?? []).slice(0, 3).map((source) => (
                  <div key={source}>
                    <span>{sourceKind(source)}</span>
                    <p>{clipText(source)}</p>
                  </div>
                ))}
                {(entry.card.sources ?? []).length === 0 && <div className="muted">没有保存证据引用。</div>}
              </div>
            </div>
            <div className="review-side generation-card-rail">
              <div className="score-pair review-score-pair">
                <div>
                  <span>用户</span>
                  <strong>{scoreLabel(entry.rewards.userReward)}</strong>
                </div>
                <div>
                  <span>人工</span>
                  <strong>{scoreLabel(entry.rewards.reviewerReward)}</strong>
                </div>
                <div>
                  <span>评估</span>
                  <strong>{scoreLabel(entry.evaluation?.overall)}</strong>
                </div>
                <div>
                  <span>分差</span>
                  <strong>{scoreLabel(scoreGap(entry))}</strong>
                </div>
              </div>
              <div className="reviewer-score-hint">
                <span>人工结论</span>
                <strong>{entry.rewards.reviewerReward === null ? "待打分" : scoreLabel(entry.rewards.reviewerReward)}</strong>
              </div>
              <ScoreControl
                current={entry.rewards.reviewerReward}
                disabled={savingCard === entry.card.id}
                onScore={(score) => saveScore(entry.card.id, score)}
              />
              <div className="evaluation-text">{entry.evaluation?.feedback ?? "没有评估器反馈"}</div>
              <CasebookEditor
                cardId={entry.card.id}
                initialLabel={entry.casebook?.label ?? "great"}
                initialNote={entry.casebook?.reviewerNote}
                onSaved={load}
              />
              <button className="plain-button" onClick={() => onNavigate(`/cards/${entry.card.id}`)}>
                <Search size={15} /> 卡片详情
              </button>
            </div>
          </section>
          );
        })}
        {visibleCards.length === 0 && (
          <section className="panel compact">
            <div className="muted">当前评审筛选下没有卡片。</div>
          </section>
        )}
      </div>
    </div>
  );
}
