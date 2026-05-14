import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCopy,
  Database,
  ExternalLink,
  FileText,
  Filter,
  GitBranch,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { buildTrace, cardTitle, getRun, runReviewMarkdown, scoreCard, scoreLabel } from "@/api/reward";
import type { RunDetail, TraceArtifact } from "@/api/reward";
import { CasebookEditor } from "@/components/CasebookEditor";
import { ScoreControl } from "@/components/ScoreControl";
import { StateBlock } from "@/components/StateBlock";
import { copyText } from "@/lib/clipboard";
import { dashboardDisplayId, dashboardRouteDisabledReason, dashboardRoutes, firstDashboardRouteId, hasDashboardRouteId } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";
import { safeExternalHref } from "@/lib/externalUrl";
import { staleMutationRefreshError } from "@/lib/mutationRefresh";
import { initialLoadRecoveryVisible, staleRefreshErrorMessage } from "@/lib/recoveryState";
import { redactedJsonString } from "@/lib/redaction";
import { scoreSaveErrorMessage } from "@/lib/reviewStatus";
import { finiteScore } from "@/lib/runSummary";
import {
  TRACE_STAGES,
  cardSummary,
  cardWhyNow,
  clipText,
  firstSentences,
  inferredDataSources,
  primaryActionLabel,
  readableTraceLines,
  runCards,
  sourceLabel,
  sourcePreview,
  stageNodes,
  stageSnippets,
  stringList,
  summarizeSources,
  traceStatusClass,
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

function formatRunDateTime(value: string | null | undefined): string {
  return formatDateTimeOrDash(value, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }, "zh-CN");
}

type CardFilter = "all" | "unreviewed" | "casebook";
type CardSort = "order" | "evaluator_desc" | "evaluator_gap" | "reviewer_low";
type LoadOptions = { bubbleError?: boolean };

const STAGE_ICONS = {
  "data-collector": Database,
  planner: Filter,
  "card-generator": FileText,
  evaluator: ShieldCheck,
} satisfies Record<TraceStage, typeof Database>;

export function scoreGap(entry: RunDetail["cards"][number]): number | null {
  const evaluatorScore = finiteScore(entry.evaluation?.overall);
  const humanScore = finiteScore(entry.rewards.reviewerReward) ?? finiteScore(entry.rewards.userReward);
  if (evaluatorScore === null || humanScore === null) return null;
  return evaluatorScore - humanScore;
}

export function scoreGapMagnitude(entry: RunDetail["cards"][number]): number {
  return Math.abs(scoreGap(entry) ?? 0);
}

export function hasReviewerScore(entry: RunDetail["cards"][number]): boolean {
  return finiteScore(entry.rewards.reviewerReward) !== null;
}

export function runDetailTraceRouteId(
  run: Pick<RunDetail["run"], "id" | "runId"> | null | undefined,
  routeRunId: string,
): string {
  return firstDashboardRouteId(run?.runId, routeRunId, run?.id);
}

export function runDetailCardRouteId(entry: RunDetail["cards"][number]): string {
  return firstDashboardRouteId(entry.card.id);
}

export function runDetailCardSources(card: RunDetail["cards"][number]["card"]): string[] {
  return stringList(card.sources);
}

export function runDetailRecordCount(value: unknown): number {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).length
    : 0;
}

export function runDetailCards(detail: Pick<RunDetail, "cards"> | null | undefined): RunDetail["cards"] {
  return runCards(detail);
}

export function runCopyUnavailableMessage(markdown: string, savingCard: string | null): string | null {
  if (savingCard) return "正在保存卡片状态，刷新完成后再复制。";
  if (!markdown.trim()) return "当前批次没有可复制摘要。";
  return null;
}

export function cardIndex(entry: RunDetail["cards"][number], cards: RunDetail["cards"]): number {
  const identityIndex = cards.findIndex((candidate) => candidate === entry);
  if (identityIndex >= 0) return identityIndex;
  const cardId = firstDashboardRouteId(entry.card.id);
  if (cardId) {
    const idIndex = cards.findIndex((candidate) => firstDashboardRouteId(candidate.card.id) === cardId);
    if (idIndex >= 0) return idIndex;
  }
  return 0;
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

export function generationSummary(detail: RunDetail, trace: TraceArtifact | null, dataSources: string[]): string {
  if (detail.cards.length === 0) {
    return trace?.error
      ? `本轮没有落地卡片。链路记录显示：${trace.error}`
      : "本轮没有落地卡片。需要看链路摘要确认是数据为空、规划器过滤，还是评估器全部未通过。";
  }
  const firstCard = detail.cards[0];
  const evaluatorScore = finiteScore(firstCard.evaluation?.overall);
  const evaluatorText = evaluatorScore === null
    ? "还没有保存首张卡的评估器分"
    : `评估器给到 ${scoreLabel(evaluatorScore)}`;
  return `本轮读取 ${summarizeSources(dataSources)}，生成 ${detail.cards.length} 张卡。第一张是「${clipText(cardTitle(firstCard.card), 140)}」，${evaluatorText}。`;
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
      readable[0] ?? (firstCard ? `优先选择「${clipText(cardTitle(firstCard.card), 140)}」，因为：${firstSentences(cardWhyNow(firstCard.card), 240)}` : "规划器没有留下可展示的卡片计划。"),
    ];
  }
  if (stage === "card-generator") {
    return [
      detail.cards.length > 0 ? `写出 ${detail.cards.length} 张通过落库的卡片。` : "没有卡片进入最终落库。",
      firstCard ? `首张摘要：${firstSentences(cardSummary(firstCard.card), 240)}` : "没有可展示的卡片摘要。",
    ];
  }
  const averageEvaluator = average(detail.cards.map((entry) => entry.evaluation?.overall));
  return [
    averageEvaluator === null ? "还没有保存可用评估器分。" : `平均评估分：${scoreLabel(averageEvaluator)}。`,
    readable[0] ?? (firstCard?.evaluation?.feedback ? `质量备注：${firstSentences(firstCard.evaluation.feedback, 240)}` : "没有保存评估器反馈。"),
  ];
}

export function RunDetailView({ runId, onNavigate }: RunDetailViewProps) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [trace, setTrace] = useState<TraceArtifact | null>(null);
  const [traceAttemptedRun, setTraceAttemptedRun] = useState<string | null>(null);
  const [traceMessage, setTraceMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [savingCard, setSavingCard] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [scoreMessage, setScoreMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [cardFilter, setCardFilter] = useState<CardFilter>("all");
  const [cardSort, setCardSort] = useState<CardSort>("order");
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const activeRunRouteRef = useRef(runId);
  activeRunRouteRef.current = runId;

  const load = useCallback(async (options: LoadOptions = {}) => {
    const routeRunId = runId;
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setError(null);
    try {
      const next = await getRun(routeRunId);
      if (routeRunId !== activeRunRouteRef.current || requestId !== requestSeq.current) {
        if (options.bubbleError) throw staleMutationRefreshError();
        return;
      }
      setDetail(next);
      setTrace(next.trace);
    } catch (err) {
      if (routeRunId !== activeRunRouteRef.current || requestId !== requestSeq.current) {
        if (options.bubbleError) throw staleMutationRefreshError();
        return;
      }
      if (requestId === requestSeq.current) {
        if (!options.bubbleError) {
          setError(err instanceof Error ? err.message : "加载失败");
        }
        if (options.bubbleError) {
          throw err;
        }
      }
    }
  }, [runId]);

  useEffect(() => {
    setDetail(null);
    setTrace(null);
    setTraceAttemptedRun(null);
    setTraceMessage(null);
    setCopyMessage(null);
    setMarkdownOpen(false);
    setScoreMessage(null);
    setError(null);
    void load();
  }, [load, runId]);

  useEffect(() => {
    const canonicalRunId = runDetailTraceRouteId(detail?.run, runId);
    if (!canonicalRunId || traceAttemptedRun === canonicalRunId || trace?.langsmithUrl) return;
    let cancelled = false;
    setTraceAttemptedRun(canonicalRunId);
    setTraceMessage({ kind: "status", text: "正在定位 LangSmith 链路" });
    buildTrace(canonicalRunId, trace?.status === "missing" || trace?.status === "failed")
      .then((result) => {
        if (cancelled) return;
        setTrace(result.trace);
        setTraceMessage(
          result.trace.langsmithUrl
            ? null
            : { kind: "error", text: clipText(result.trace.error ?? "没有找到 LangSmith 链路", 420) },
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setTraceMessage({
          kind: "error",
          text: err instanceof Error ? `链路定位失败：${clipText(err.message, 360)}` : "链路定位失败",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.run.id, detail?.run.runId, runId, trace?.langsmithUrl, trace?.status, traceAttemptedRun]);

  async function saveScore(cardId: string, score: number) {
    if (!hasDashboardRouteId(cardId)) {
      setScoreMessage({ kind: "error", text: "当前卡片缺少 ID，不能保存人工评分。" });
      return;
    }
    const routeRunId = runId;
    setSavingCard(cardId);
    setScoreMessage(null);
    let saved = false;
    try {
      await scoreCard(cardId, score);
      saved = true;
      if (activeRunRouteRef.current !== routeRunId) return;
      await load({ bubbleError: true });
      if (activeRunRouteRef.current !== routeRunId) return;
      setScoreMessage({ kind: "status", text: `已保存人工评分：${scoreLabel(score)}。` });
    } catch (err) {
      if (activeRunRouteRef.current !== routeRunId) return;
      setScoreMessage({
        kind: "error",
        text: scoreSaveErrorMessage(saved, err),
      });
    } finally {
      if (activeRunRouteRef.current === routeRunId) {
        setSavingCard(null);
      }
    }
  }

  const cards = useMemo(() => runDetailCards(detail), [detail]);
  const reviewedCount = cards.filter(hasReviewerScore).length;
  const reviewedPercent = cards.length > 0
    ? Math.round((reviewedCount / cards.length) * 100)
    : 0;
  const visibleCards = useMemo(() => {
    if (!detail) return [];
    const filtered = cards.filter((entry) => {
      if (cardFilter === "unreviewed") return !hasReviewerScore(entry);
      if (cardFilter === "casebook") return Boolean(entry.casebook);
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (cardSort === "evaluator_desc") {
        return (finiteScore(b.evaluation?.overall) ?? -1) - (finiteScore(a.evaluation?.overall) ?? -1);
      }
      if (cardSort === "evaluator_gap") {
        return scoreGapMagnitude(b) - scoreGapMagnitude(a);
      }
      if (cardSort === "reviewer_low") {
        const aScore = finiteScore(a.rewards.reviewerReward) ?? Number.POSITIVE_INFINITY;
        const bScore = finiteScore(b.rewards.reviewerReward) ?? Number.POSITIVE_INFINITY;
        return aScore - bScore;
      }
      return cardIndex(a, cards) - cardIndex(b, cards);
    });
  }, [cardFilter, cardSort, cards, detail]);

  if (initialLoadRecoveryVisible(error, detail)) {
    return (
      <div className="stack">
        <div className="view-toolbar">
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.runs)} type="button">
            <ArrowLeft size={16} /> 批次列表
          </button>
          <div className="toolbar-actions">
            <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.trace(runId))} type="button">
              <GitBranch size={16} /> 生成链路
            </button>
            <button className="plain-button" onClick={() => void load()} type="button">
              <RefreshCw size={16} /> 重新加载
            </button>
          </div>
        </div>
        <StateBlock title="批次加载失败" detail={error ?? undefined} />
      </div>
    );
  }
  if (!detail) return <StateBlock title="正在加载批次" />;

  const currentDetail: RunDetail = { ...detail, cards };
  const reviewMarkdown = runReviewMarkdown(currentDetail, runId);
  const langsmithUrl = safeExternalHref(trace?.langsmithUrl || (
    typeof trace?.traceTree.langsmithUrl === "string" ? trace.traceTree.langsmithUrl : ""
  ));
  const largestGap = cards
    .map((entry) => ({ entry, gap: scoreGap(entry) }))
    .filter((item): item is { entry: RunDetail["cards"][number]; gap: number } => item.gap !== null)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
  const lowestEvaluator = [...cards]
    .filter((entry) => finiteScore(entry.evaluation?.overall) !== null)
    .sort((a, b) => (finiteScore(a.evaluation?.overall) ?? 99) - (finiteScore(b.evaluation?.overall) ?? 99))[0];
  const traceDataSources = stringList(trace?.summary.dataSources);
  const dataSources = traceDataSources.length > 0 ? traceDataSources : inferredDataSources(currentDetail);
  const firstCardSources = sourcePreview(cards[0]?.card);
  const traceRouteId = runDetailTraceRouteId(detail.run, runId);
  const canOpenTrace = hasDashboardRouteId(traceRouteId);
  const copyUnavailableMessage = runCopyUnavailableMessage(reviewMarkdown, savingCard);
  const refreshErrorText = staleRefreshErrorMessage(error, detail, "批次");

  function refreshRunDetail() {
    setTraceMessage(null);
    setCopyMessage(null);
    setMarkdownOpen(false);
    setScoreMessage(null);
    void load();
  }

  async function copyRunMarkdown() {
    if (copyUnavailableMessage) {
      setCopyMessage(copyUnavailableMessage);
      return;
    }
    setMarkdownOpen(true);
    const copied = await copyText(reviewMarkdown);
    setCopyMessage(copied ? "已复制批次复盘摘要。" : "当前浏览器不支持自动复制，请从页面内容手动复制。");
  }

  return (
    <div className="stack">
      <div className="view-toolbar">
        <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.runs)} type="button">
          <ArrowLeft size={16} /> 批次列表
        </button>
        <div className="toolbar-actions">
          <button
            className="plain-button"
            disabled={!canOpenTrace}
            onClick={() => onNavigate(dashboardRoutes.trace(traceRouteId))}
            title={canOpenTrace ? "打开生成链路" : dashboardRouteDisabledReason("trace")}
            type="button"
          >
            <GitBranch size={16} /> 生成链路
          </button>
          <button className="plain-button" onClick={refreshRunDetail} disabled={savingCard !== null} type="button">
            <RefreshCw size={16} /> 刷新批次
          </button>
          <button
            aria-controls="run-review-markdown-export"
            aria-expanded={markdownOpen}
            className="plain-button"
            disabled={copyUnavailableMessage !== null}
            onClick={() => void copyRunMarkdown()}
            title={copyUnavailableMessage ?? "复制批次复盘摘要"}
            type="button"
          >
            <ClipboardCopy size={16} /> 复制摘要
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
              {formatRunDateTime(detail.run.completedAt) === "-" ? "未完成" : formatRunDateTime(detail.run.completedAt)}
              {" "} / {cards.length} 张卡 / {dashboardDisplayId(detail.run.runId, detail.run.id, runId)}
            </p>
          </div>
          <span className={`status-pill ${traceStatusClass(trace?.status ?? "missing")}`}>
            {traceStatusLabel(trace?.status)}
          </span>
        </div>
        {traceMessage && (
          <div
            className={traceMessage.kind === "error" ? "inline-error" : "inline-status"}
            role={traceMessage.kind === "error" ? "alert" : "status"}
          >
            {traceMessage.text}
          </div>
        )}
        {copyMessage && <div className="inline-status" role="status">{copyMessage}</div>}
        {refreshErrorText && <div className="inline-error" role="alert">{refreshErrorText}</div>}
        {markdownOpen && (
          <textarea
            aria-label="批次复盘 markdown 导出"
            className="markdown-export"
            id="run-review-markdown-export"
            readOnly
            rows={12}
            value={reviewMarkdown}
          />
        )}
        {scoreMessage && (
          <div className={scoreMessage.kind === "error" ? "inline-error" : "inline-status"} role={scoreMessage.kind === "error" ? "alert" : "status"}>
            {scoreMessage.text}
          </div>
        )}
        <div className="run-overview-grid">
          <div>
            <span>触发来源</span>
            <strong>{detail.run.trigger ?? "-"}</strong>
          </div>
          <div>
            <span>人工平均分</span>
            <strong>{scoreLabel(
              average(cards.map((entry) => entry.rewards.reviewerReward)),
            )}</strong>
          </div>
          <div>
            <span>评估平均分</span>
            <strong>{scoreLabel(
              average(cards.map((entry) => entry.evaluation?.overall)),
            )}</strong>
          </div>
          <div>
            <span>已保存样本</span>
            <strong>{cards.filter((entry) => entry.casebook).length}</strong>
          </div>
        </div>
      </section>
      <section className="panel generation-process-panel">
        <div className="panel-head">
          <div>
            <h2>生成过程</h2>
            <p>{generationSummary(currentDetail, trace, dataSources)}</p>
          </div>
          <span className={`status-pill ${traceStatusClass(trace?.status ?? "missing")}`}>
            链路{traceStatusLabel(trace?.status)}
          </span>
        </div>
        <div className="generation-source-row">
          {dataSources.length > 0
            ? dataSources.map((source, sourceIndex) => <span key={`${sourceIndex}:data-source`}>{sourceLabel(source)}</span>)
            : <span>没有识别到输入来源</span>}
        </div>
        <div className="generation-stage-grid">
          {TRACE_STAGES.map((stage, index) => {
            const StageIcon = STAGE_ICONS[stage];
            const highlights = stageHighlights(stage, currentDetail, trace, dataSources);
            return (
              <article className="generation-stage-card" key={stage}>
                <div className="generation-stage-head">
                  <span><StageIcon size={16} /> 第 {index + 1} 步</span>
                  <strong>{stageLabel(stage)}</strong>
                </div>
                <p>{stageExplanation(stage)}</p>
                <ul>
                  {highlights.map((highlight, highlightIndex) => (
                    <li key={`stage-highlight-${highlightIndex}`}><CheckCircle2 size={14} /> {highlight}</li>
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
              {(firstCardSources.length > 0 ? firstCardSources.slice(0, 4) : ["当前批次没有保存卡片证据引用。"]).map((source, sourceIndex) => (
                <p key={`${sourceIndex}:card-source`}>{clipText(source, 260)}</p>
              ))}
            </div>
          </div>
        </div>
        {trace?.summary && (
          <details className="raw-details compact">
            <summary>查看标准化链路摘要 JSON</summary>
            <pre className="json-block">{redactedJsonString(trace.summary)}</pre>
          </details>
        )}
      </section>
      <section className="review-workbar">
        <div className="review-workbar-copy">
          <strong>还剩 {cards.length - reviewedCount} 张待评审</strong>
          <span>{reviewedCount} / {cards.length} 张已评审 · 当前显示 {visibleCards.length} 张</span>
          <div className="review-workbar-progress" aria-label="批次评审进度">
            <div style={{ width: `${reviewedPercent}%` }} />
          </div>
        </div>
        <div className="filter-row">
          <select aria-label="卡片评审状态筛选" value={cardFilter} onChange={(event) => setCardFilter(event.target.value as CardFilter)}>
            <option value="all">全部卡片</option>
            <option value="unreviewed">未评审</option>
            <option value="casebook">已入样本库</option>
          </select>
          <select aria-label="卡片排序" value={cardSort} onChange={(event) => setCardSort(event.target.value as CardSort)}>
            <option value="order">生成顺序</option>
            <option value="evaluator_desc">评估分从高到低</option>
            <option value="evaluator_gap">绝对分差最大优先</option>
            <option value="reviewer_low">人工低分优先</option>
          </select>
        </div>
      </section>
      <section className="review-insight-grid">
        <div>
          <span>最大评估分差</span>
          <strong>{largestGap ? scoreLabel(largestGap.gap) : "-"}</strong>
          <p>{largestGap ? clipText(cardTitle(largestGap.entry.card), 160) : "还没有人工分。"}</p>
        </div>
        <div>
          <span>评估分最低卡</span>
          <strong>{lowestEvaluator ? scoreLabel(lowestEvaluator.evaluation?.overall) : "-"}</strong>
          <p>{lowestEvaluator ? clipText(cardTitle(lowestEvaluator.card), 160) : "还没有评估记录。"}</p>
        </div>
        <div>
          <span>链路状态</span>
          <strong>{traceStatusLabel(trace?.status)}</strong>
          <p>{trace?.error ?? "生成行为不清楚时，打开链路看具体过程。"}</p>
        </div>
      </section>
      <div className="card-review-list">
        {visibleCards.map((entry) => {
          const index = cardIndex(entry, cards);
          const cardMutationId = runDetailCardRouteId(entry);
          const cardKey = cardMutationId || `${index}:missing-card-id`;
          const canMutateCard = hasDashboardRouteId(cardMutationId);
          const cardSources = runDetailCardSources(entry.card);
          const feedbackEventCount = runDetailRecordCount(entry.feedbackEvents);
          const rewardEventCount = runDetailRecordCount(entry.rewardHistory);
          return (
            <section className="review-card generation-card" key={cardKey}>
              <div className="review-main">
                <div className="review-card-head">
                  <div className="card-meta-line">
                    <span>第 {index + 1} 张</span>
                    <span>{clipText(entry.card.goalBasket ?? entry.card.goal_basket ?? "未知领域", 120)}</span>
                    <span>{clipText(entry.card.intentKey ?? entry.card.intent_key ?? "无意图", 120)}</span>
                    <span>{cardSources.length} 条证据</span>
                    <span>{feedbackEventCount} 条反馈</span>
                    <span>{rewardEventCount} 个奖励事件</span>
                    <span>{entry.casebook ? "已保存样本" : "未入样本库"}</span>
                  </div>
                  <h3>{clipText(cardTitle(entry.card), 180)}</h3>
                  <p className="card-summary-text">{cardSummary(entry.card)}</p>
                </div>
                <div className="card-decision-grid">
                  {primaryActionLabel(entry.card) && (
                    <div className="action-callout">
                      <span>建议动作</span>
                      <strong>{clipText(primaryActionLabel(entry.card) ?? "", 140)}</strong>
                    </div>
                  )}
                  <div className="why-now-card">
                    <span>为什么现在</span>
                    <p>{cardWhyNow(entry.card)}</p>
                  </div>
                </div>
                <div className="source-evidence-preview elevated">
                  <span className="section-label">证据引用</span>
                  {cardSources.slice(0, 3).map((source, sourceIndex) => (
                    <div key={`${sourceIndex}:card-source`}>
                      <span>{sourceKind(source)}</span>
                      <p>{clipText(source)}</p>
                    </div>
                  ))}
                  {cardSources.length === 0 && <div className="muted">没有保存证据引用。</div>}
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
                  <strong>{hasReviewerScore(entry) ? scoreLabel(entry.rewards.reviewerReward) : "待打分"}</strong>
                </div>
                <ScoreControl
                  current={finiteScore(entry.rewards.reviewerReward)}
                  disabled={savingCard === cardMutationId || !canMutateCard}
                  disabledReason={!canMutateCard ? "当前卡片缺少 ID，不能保存人工评分。" : undefined}
                  onScore={(score) => saveScore(cardMutationId, score)}
                />
                <div className="evaluation-text">{clipText(entry.evaluation?.feedback ?? "没有评估器反馈", 420)}</div>
                <CasebookEditor
                  cardId={cardMutationId}
                  disabled={!canMutateCard}
                  disabledReason="当前卡片缺少 ID，不能保存到样本库。"
                  initialLabel={entry.casebook?.label ?? "great"}
                  initialNote={entry.casebook?.reviewerNote}
                  onSaved={async () => {
                    if (activeRunRouteRef.current !== runId) throw staleMutationRefreshError();
                    await load({ bubbleError: true });
                  }}
                />
                <div className="review-card-actions">
                  <button
                    className="plain-button"
                    disabled={!canMutateCard}
                    onClick={() => onNavigate(dashboardRoutes.card(cardMutationId))}
                    title={canMutateCard ? "打开卡片详情" : dashboardRouteDisabledReason("card")}
                    type="button"
                  >
                    <Search size={15} /> 卡片详情
                  </button>
                  <button
                    className="plain-button"
                    disabled={!canOpenTrace}
                    onClick={() => onNavigate(dashboardRoutes.trace(traceRouteId))}
                    title={canOpenTrace ? "打开生成链路" : dashboardRouteDisabledReason("trace")}
                    type="button"
                  >
                    <GitBranch size={15} /> 批次链路
                  </button>
                  <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
                    <CheckCircle2 size={15} /> 样本库
                  </button>
                </div>
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
