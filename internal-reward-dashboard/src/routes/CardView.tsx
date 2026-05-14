import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCopy,
  Database,
  ExternalLink,
  Filter,
  GitBranch,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Target,
} from "lucide-react";
import { buildTrace, cardReviewMarkdown, cardTitle, getCard, scoreCard, scoreLabel } from "@/api/reward";
import type { CardDetail, TraceArtifact } from "@/api/reward";
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

interface CardViewProps {
  cardId: string;
  onNavigate: (path: string) => void;
}

type LoadOptions = { bubbleError?: boolean };

function formatDate(value: string | null | undefined): string {
  return formatDateTimeOrDash(value, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }, "zh-CN");
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

export function evaluatorStatus(
  evaluation: CardDetail["evaluation"],
): { className: "failed" | "neutral" | "ready"; label: string } {
  if (!evaluation) return { className: "neutral", label: "待确认" };
  return evaluation.pass
    ? { className: "ready", label: "通过" }
    : { className: "failed", label: "未通过" };
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

export function feedbackText(event: Record<string, unknown>, key: string, max = 120): string {
  const value = event[key];
  if (typeof value === "string" && value.trim()) return clipText(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "-";
}

export function feedbackEventKey(event: Record<string, unknown>, index: number): string {
  const id = event.id;
  if (typeof id === "string" && id.trim()) return `${index}:${id}`;
  if (typeof id === "number" || typeof id === "boolean") return `${index}:${String(id)}`;
  return `feedback-${index}`;
}

export function cardTraceRouteId(run: Pick<CardDetail["run"], "id" | "runId">): string {
  return firstDashboardRouteId(run.runId, run.id);
}

export function cardCopyUnavailableMessage(markdown: string, savingScore: boolean): string | null {
  if (savingScore) return "正在保存人工评分，刷新完成后再复制。";
  if (!markdown.trim()) return "当前卡片没有可复制摘要。";
  return null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function cardFeedbackEvents(detail: Pick<CardDetail, "feedbackEvents">): Array<Record<string, unknown>> {
  const events = detail.feedbackEvents as unknown;
  return Array.isArray(events)
    ? events.filter((event): event is Record<string, unknown> => recordField(event) !== null)
    : [];
}

export function cardRewardEvents(detail: Pick<CardDetail, "rewardHistory">): CardDetail["rewardHistory"] {
  const events = detail.rewardHistory as unknown;
  return Array.isArray(events)
    ? events.filter((event): event is CardDetail["rewardHistory"][number] => recordField(event) !== null)
    : [];
}

export function cardRelatedRows(detail: Pick<CardDetail, "relatedCards">): CardDetail["relatedCards"] {
  const rows = detail.relatedCards as unknown;
  return Array.isArray(rows)
    ? rows.filter((row): row is CardDetail["relatedCards"][number] => {
        const record = recordField(row);
        return record !== null && recordField(record.card) !== null;
      })
    : [];
}

function rewardSourceText(value: unknown): string {
  if (typeof value !== "string") return "-";
  return {
    reviewer: "人工",
    system: "系统",
    user: "用户",
  }[value] ?? value;
}

function eventTypeText(value: unknown): string {
  if (typeof value !== "string") return "-";
  return {
    reviewer_score: "人工评分",
    system_score: "系统评分",
    user_score: "用户评分",
  }[value] ?? value;
}

function actionLabelValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.replace(/\s+/g, " ").trim();
  return label || null;
}

function actionTypeValue(value: unknown, fallback: "primary" | "secondary"): "primary" | "secondary" {
  return value === "primary" ? "primary" : fallback;
}

export function cardActions(card: CardDetail["card"]): Array<{ label: string; type: "primary" | "secondary" }> {
  const primary = recordField(card.primaryAction ?? card.primary_action);
  const secondary = (card.secondaryActions ?? card.secondary_actions) as unknown;
  const out: Array<{ label: string; type: "primary" | "secondary" }> = [];
  const primaryLabel = primary ? actionLabelValue(primary.label) : null;
  if (primaryLabel) {
    out.push({ label: primaryLabel, type: actionTypeValue(primary?.type, "primary") });
  }
  if (Array.isArray(secondary)) {
    for (const item of secondary) {
      const action = recordField(item);
      const label = action ? actionLabelValue(action.label) : null;
      if (label) {
        out.push({ label, type: actionTypeValue(action?.type, "secondary") });
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
  const primary = recordField(card.primaryAction ?? card.primary_action);
  return (primary ? actionLabelValue(primary.label) : null) ?? "没有保存建议动作。";
}

function evaluatorGap(detail: CardDetail): number | null {
  const evaluatorScore = finiteScore(detail.evaluation?.overall);
  const humanScore = finiteScore(detail.rewards.reviewerReward) ?? finiteScore(detail.rewards.userReward);
  return evaluatorScore === null || humanScore === null ? null : evaluatorScore - humanScore;
}

function signedScore(value: number | null): string {
  if (value === null) return "-";
  const text = scoreLabel(value);
  return value > 0 ? `+${text}` : text;
}

function gapTone(value: number | null): "high" | "mid" | "low" | "empty" {
  if (value === null) return "empty";
  const absolute = Math.abs(value);
  if (absolute >= 3) return "low";
  if (absolute >= 1.5) return "mid";
  return "high";
}

export function CardView({ cardId, onNavigate }: CardViewProps) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [trace, setTrace] = useState<TraceArtifact | null>(null);
  const [traceAttemptedRun, setTraceAttemptedRun] = useState<string | null>(null);
  const [traceMessage, setTraceMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [scoreMessage, setScoreMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [savingScore, setSavingScore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const activeCardRouteRef = useRef(cardId);
  activeCardRouteRef.current = cardId;

  const load = useCallback(async (options: LoadOptions = {}) => {
    const routeCardId = cardId;
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setError(null);
    try {
      const next = await getCard(routeCardId);
      if (routeCardId !== activeCardRouteRef.current || requestId !== requestSeq.current) {
        if (options.bubbleError) throw staleMutationRefreshError();
        return;
      }
      setDetail(next);
      setTrace(next.trace);
      setError(null);
    } catch (err) {
      if (routeCardId !== activeCardRouteRef.current || requestId !== requestSeq.current) {
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
  }, [cardId]);

  useEffect(() => {
    setDetail(null);
    setTrace(null);
    setTraceAttemptedRun(null);
    setTraceMessage(null);
    setCopyMessage(null);
    setMarkdownOpen(false);
    setScoreMessage(null);
    setSavingScore(false);
    setError(null);
    void load();
  }, [cardId, load]);

  useEffect(() => {
    const runId = detail ? cardTraceRouteId(detail.run) : "";
    if (!runId || traceAttemptedRun === runId || trace?.langsmithUrl) return;
    let cancelled = false;
    setTraceAttemptedRun(runId);
    setTraceMessage({ kind: "status", text: "正在定位 LangSmith 链路" });
    buildTrace(runId, trace?.status === "missing" || trace?.status === "failed")
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
  }, [detail?.run.id, detail?.run.runId, trace?.langsmithUrl, trace?.status, traceAttemptedRun]);

  if (initialLoadRecoveryVisible(error, detail)) {
    return (
      <div className="stack">
        <div className="view-toolbar">
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.runs)} type="button">
            <ArrowLeft size={16} /> 批次列表
          </button>
          <div className="toolbar-actions">
            <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
              <CheckCircle2 size={16} /> 样本库
            </button>
            <button className="plain-button" onClick={() => void load()} disabled={savingScore} type="button">
              <RefreshCw size={16} /> 重新加载
            </button>
          </div>
        </div>
        <StateBlock title="卡片加载失败" detail={error ?? undefined} />
      </div>
    );
  }
  if (!detail) return <StateBlock title="正在加载卡片" />;

  const currentDetail = detail;
  const reviewMarkdown = cardReviewMarkdown(currentDetail, cardId);
  const sources = listField(detail.card.sources);
  const sourceKindLabels = sourceKinds(sources);
  const actions = cardActions(detail.card);
  const feedbackEvents = cardFeedbackEvents(detail);
  const rewardHistory = cardRewardEvents(detail);
  const relatedCards = cardRelatedRows(detail);
  const gap = evaluatorGap(detail);
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
  const langsmithUrl = safeExternalHref(trace?.langsmithUrl);
  const cardMutationId = firstDashboardRouteId(detail.card.id, cardId);
  const canMutateCard = hasDashboardRouteId(cardMutationId);
  const runRouteId = firstDashboardRouteId(detail.run.id, detail.run.runId);
  const traceRouteId = cardTraceRouteId(detail.run);
  const canOpenRun = hasDashboardRouteId(runRouteId);
  const canOpenTrace = hasDashboardRouteId(traceRouteId);
  const copyUnavailableMessage = cardCopyUnavailableMessage(reviewMarkdown, savingScore);
  const refreshErrorText = staleRefreshErrorMessage(error, detail, "卡片");
  const evaluatorStatusValue = evaluatorStatus(detail.evaluation);

  function refreshCardDetail() {
    setTraceMessage(null);
    setCopyMessage(null);
    setMarkdownOpen(false);
    setScoreMessage(null);
    void load();
  }

  async function copyReviewMarkdown() {
    if (copyUnavailableMessage) {
      setCopyMessage(copyUnavailableMessage);
      return;
    }
    setMarkdownOpen(true);
    const copied = await copyText(reviewMarkdown);
    setCopyMessage(copied ? "已复制单卡复盘摘要。" : "当前浏览器不支持自动复制，请从页面内容手动复制。");
  }

  async function saveReviewerScore(score: number) {
    if (!canMutateCard) {
      setScoreMessage({ kind: "error", text: "当前卡片缺少 ID，不能保存人工评分。" });
      return;
    }
    const routeCardId = cardId;
    setSavingScore(true);
    setScoreMessage(null);
    let saved = false;
    try {
      await scoreCard(cardMutationId, score);
      saved = true;
      if (activeCardRouteRef.current !== routeCardId) return;
      await load({ bubbleError: true });
      if (activeCardRouteRef.current !== routeCardId) return;
      setScoreMessage({ kind: "status", text: `已保存人工评分：${scoreLabel(score)}。` });
    } catch (err) {
      if (activeCardRouteRef.current !== routeCardId) return;
      setScoreMessage({
        kind: "error",
        text: scoreSaveErrorMessage(saved, err),
      });
    } finally {
      if (activeCardRouteRef.current === routeCardId) {
        setSavingScore(false);
      }
    }
  }

  return (
    <div className="stack">
      <div className="view-toolbar">
        <button
          className="plain-button"
          disabled={!canOpenRun}
          onClick={() => onNavigate(dashboardRoutes.run(runRouteId))}
          title={canOpenRun ? "返回批次评审" : dashboardRouteDisabledReason("run")}
          type="button"
        >
          <ArrowLeft size={16} /> 返回批次
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
          <button className="plain-button" onClick={refreshCardDetail} disabled={savingScore} type="button">
            <RefreshCw size={16} /> 刷新卡片
          </button>
          {langsmithUrl && (
            <a className="plain-button" href={langsmithUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> LangSmith
            </a>
          )}
        </div>
      </div>
      <section className="panel card-detail-hero">
        <div className="panel-head">
          <div>
            <h2>{clipText(cardTitle(detail.card), 180)}</h2>
            <p>{dashboardDisplayId(detail.card.id, cardId)}</p>
            <div className="card-meta-line">
              <span>{clipText(detail.card.goalBasket ?? detail.card.goal_basket ?? "未知领域", 120)}</span>
              <span>{clipText(detail.card.intentKey ?? detail.card.intent_key ?? "无意图", 120)}</span>
              <span>批次 {clipText(detail.run.trigger ?? "-", 80)}</span>
              <span>链路{traceStatusLabel(trace?.status)}</span>
            </div>
            {traceMessage && (
              <div
                className={traceMessage.kind === "error" ? "inline-error" : "inline-status"}
                role={traceMessage.kind === "error" ? "alert" : "status"}
              >
                {traceMessage.text}
              </div>
            )}
            {refreshErrorText && <div className="inline-error" role="alert">{refreshErrorText}</div>}
          </div>
          <div className="score-pair compact-score">
            <div><span>用户分</span><strong>{scoreLabel(detail.rewards.userReward)}</strong></div>
            <div><span>人工分</span><strong>{scoreLabel(detail.rewards.reviewerReward)}</strong></div>
            <div><span>评估分</span><strong>{scoreLabel(detail.evaluation?.overall)}</strong></div>
          </div>
        </div>
        <div className="card-review-summary-grid">
          <div className={`tone-${scoreTone(detail.rewards.reviewerReward)}`}>
            <span>人工判断</span>
            <strong>{finiteScore(detail.rewards.reviewerReward) === null ? "待评分" : scoreLabel(detail.rewards.reviewerReward)}</strong>
            <p>{detail.rewards.latestReviewerScoreAt ? `更新于 ${formatDate(detail.rewards.latestReviewerScoreAt)}` : "还没有 reviewer score。"}</p>
          </div>
          <div className={`tone-${gapTone(gap)}`}>
            <span>评估分差</span>
            <strong>{signedScore(gap)}</strong>
            <p>{gap !== null && Math.abs(gap) >= 3 ? "优先复盘评估器高估/低估。" : "评估器和人工信号暂未明显冲突。"}</p>
          </div>
          <div>
            <span>反馈事件</span>
            <strong>{feedbackEvents.length}</strong>
            <p>{detail.rewards.opened ? "用户打开过这张卡。" : "还没有 card_open 记录。"}</p>
          </div>
          <div>
            <span>证据与样本</span>
            <strong>{sources.length} / {detail.casebook ? "已保存" : "未保存"}</strong>
            <p>{detail.casebook ? caseLabelText(detail.casebook.label) : "可按好/坏/重复等标签入样本库。"}</p>
          </div>
        </div>
        <div className="card-detail-layout">
          <div className="card-detail-main">
            <section className="card-snapshot-block">
              <div className="section-kicker">卡片正文</div>
              <h3>{detail.card.summary ? "用户看到的核心判断" : "没有保存摘要"}</h3>
              <p>{clipText(detail.card.summary ?? "这张卡没有保存摘要。", 420)}</p>
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
                  {(sourceKindLabels.length > 0 ? sourceKindLabels : ["无来源"]).map((kind, kindIndex) => (
                    <span key={`source-kind-${kindIndex}`}>{kind}</span>
                  ))}
                </div>
                <div className="evidence-list refined">
                  {sources.slice(0, 6).map((source, index) => (
                    <article className="evidence-row" key={`${index}:evidence-source`}>
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
                    <p>{clipText(detail.card.whyNow ?? detail.card.why_now ?? "没有保存时机说明。", 420)}</p>
                  </div>
                  <div className="decision-item">
                    <span>建议动作</span>
                    <strong>{clipText(primaryActionLabel(detail.card), 140)}</strong>
                  </div>
                  {actions.length > 0 && (
                    <div className="action-list refined">
                      {actions.map((action, actionIndex) => (
                        <span key={`${actionIndex}:recommended-action`}>
                          {actionTypeText(action.type)}：{clipText(action.label, 180)}
                        </span>
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
          <aside aria-label="单卡复盘动作" className="review-rail card-review-rail">
            <div className="rail-title">
              <Target size={17} />
              <h3>人工评分</h3>
            </div>
            <ScoreControl
              current={finiteScore(detail.rewards.reviewerReward)}
              disabled={savingScore || !canMutateCard}
              disabledReason={!canMutateCard ? "当前卡片缺少 ID，不能保存人工评分。" : undefined}
              onScore={(score) => void saveReviewerScore(score)}
            />
            {scoreMessage && (
              <div className={scoreMessage.kind === "error" ? "inline-error" : "inline-status"} role={scoreMessage.kind === "error" ? "alert" : "status"}>
                {scoreMessage.text}
              </div>
            )}
            <CasebookEditor
              cardId={cardMutationId}
              disabled={!canMutateCard}
              disabledReason="当前卡片缺少 ID，不能保存到样本库。"
              initialLabel={detail.casebook?.label ?? "great"}
              initialNote={detail.casebook?.reviewerNote}
              onSaved={async () => {
                if (activeCardRouteRef.current !== cardId) throw staleMutationRefreshError();
                await load({ bubbleError: true });
              }}
            />
            <div className="run-context">
              <div><span>批次开始</span><strong>{formatDate(detail.run.startedAt)}</strong></div>
              <div><span>批次完成</span><strong>{formatDate(detail.run.completedAt)}</strong></div>
              <div><span>样本库</span><strong>{caseLabelText(detail.casebook?.label)}</strong></div>
            </div>
            <div className="card-review-actions" aria-label="单卡复盘动作">
              <button
                className="plain-button"
                disabled={!canOpenRun}
                onClick={() => onNavigate(dashboardRoutes.run(runRouteId))}
                title={canOpenRun ? "打开批次评审" : dashboardRouteDisabledReason("run")}
                type="button"
              >
                <ListChecks size={15} /> 批次
              </button>
              <button
                className="plain-button"
                disabled={!canOpenTrace}
                onClick={() => onNavigate(dashboardRoutes.trace(traceRouteId))}
                title={canOpenTrace ? "打开生成链路" : dashboardRouteDisabledReason("trace")}
                type="button"
              >
                <GitBranch size={15} /> 链路
              </button>
              <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
                <CheckCircle2 size={15} /> 样本库
              </button>
              <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.personalData)} type="button">
                <Database size={15} /> 上下文
              </button>
              <button
                aria-controls="card-review-markdown-export"
                aria-expanded={markdownOpen}
                className="plain-button wide-action"
                disabled={copyUnavailableMessage !== null}
                onClick={() => void copyReviewMarkdown()}
                title={copyUnavailableMessage ?? "复制单卡复盘摘要"}
                type="button"
              >
                <ClipboardCopy size={15} /> 复制摘要
              </button>
            </div>
            {copyMessage && <div className="inline-status" role="status">{copyMessage}</div>}
            {markdownOpen && (
              <textarea
                aria-label="单卡复盘 markdown 导出"
                className="markdown-export"
                id="card-review-markdown-export"
                readOnly
                rows={12}
                value={reviewMarkdown}
              />
            )}
          </aside>
        </div>
      </section>
      <section className="panel evaluator-panel">
        <div className="panel-head">
          <div>
            <h2>评估器判断</h2>
            <p>模型评估器对这张卡的逐项判断。</p>
          </div>
          <span className={`status-pill ${evaluatorStatusValue.className}`}>
            {evaluatorStatusValue.label}
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
          <span>{clipText(detail.evaluation?.feedback ?? "没有评估器反馈。", 520)}</span>
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
          {rewardHistory.map((event, index) => (
            <div className="timeline-item" key={`${index}:${event.id}`}>
              <strong>{rewardSourceText(event.source)} / {eventTypeText(event.eventType)}</strong>
              <span>{scoreLabel(event.score)}</span>
              <span>{formatDate(textField(event.createdAt))}</span>
              {typeof event.reason === "string" && event.reason.trim() && <p>{clipText(event.reason, 320)}</p>}
            </div>
          ))}
          {rewardHistory.length === 0 && (
            <div className="timeline-empty">
              这张卡还没有 reward ledger 事件。打开、用户评分或人工评分后会出现在这里。
            </div>
          )}
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
          {feedbackEvents.map((event, index) => (
            <div className="feedback-event" key={feedbackEventKey(event, index)}>
              <div>
                <strong>{feedbackText(event, "kind", 80)} / {feedbackText(event, "action", 80)}</strong>
                <span>{formatDate(textField(event.createdAt))}</span>
              </div>
              <p>{feedbackText(event, "text", 420)}</p>
              <div className="card-meta-line">
                <span>{feedbackText(event, "source", 120)}</span>
                <span>{feedbackText(event, "basket", 120)}</span>
                <span>{feedbackText(event, "channel", 120)}</span>
              </div>
            </div>
          ))}
          {feedbackEvents.length === 0 && <div className="muted">这张卡还没有产品反馈事件。</div>}
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
          {relatedCards.map((related, index) => {
            const relatedRunId = typeof related.runId === "string" ? related.runId : "";
            const relatedCompletedAt = typeof related.completedAt === "string" ? related.completedAt : null;
            const relatedCardId = firstDashboardRouteId(related.card.id);
            const canOpenRelatedCard = hasDashboardRouteId(relatedCardId);
            return (
              <button
                className="related-item"
                disabled={!canOpenRelatedCard}
                key={`${index}:${relatedRunId}:${relatedCardId}`}
                onClick={() => onNavigate(dashboardRoutes.card(relatedCardId))}
                title={canOpenRelatedCard ? "打开相关卡片" : dashboardRouteDisabledReason("card")}
                type="button"
              >
                <strong>{clipText(cardTitle(related.card), 160)}</strong>
                <span>{formatDate(relatedCompletedAt) === "-" ? dashboardDisplayId(relatedRunId) : formatDate(relatedCompletedAt)}</span>
              </button>
            );
          })}
          {relatedCards.length === 0 && <div className="muted">没有相关卡片。</div>}
        </div>
      </section>
      <section className="panel compact">
        <details className="raw-details">
          <summary>原始卡片数据</summary>
          <pre className="json-block">{redactedJsonString(detail.card)}</pre>
        </details>
      </section>
    </div>
  );
}
