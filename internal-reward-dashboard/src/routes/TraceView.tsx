import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ClipboardCopy, Database, ExternalLink, FileText, Filter, ListChecks, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { buildTrace, cardTitle, getRun, getTrace, scoreLabel } from "@/api/reward";
import type { RunDetail, TraceArtifact } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { copyText } from "@/lib/clipboard";
import { dashboardRouteDisabledReason, dashboardRoutes, firstDashboardRouteId, hasDashboardRouteId } from "@/lib/dashboardRoutes";
import { safeExternalHref } from "@/lib/externalUrl";
import { initialLoadRecoveryVisible } from "@/lib/recoveryState";
import { redactedJsonString } from "@/lib/redaction";
import { traceSvgDataUrl } from "@/lib/traceSvg";
import {
  TRACE_STAGES,
  cardSummary,
  cardWhyNow,
  clipText,
  firstSentences,
  inferredDataSources,
  primaryActionLabel,
  readableSkippedLines,
  readableTraceLines,
  runCards,
  sourceLabel,
  sourcePreview,
  stageNodes,
  stringList,
  summarizeSources,
  traceReviewMarkdown,
  traceStatusClass,
  traceStatusLabel,
} from "@/lib/traceText";
import type { TraceStage } from "@/lib/traceText";

interface TraceViewProps {
  runId: string;
  onNavigate: (path: string) => void;
}

const STAGE_ICONS = {
  "data-collector": Database,
  planner: Filter,
  "card-generator": FileText,
  evaluator: ShieldCheck,
} satisfies Record<TraceStage, typeof Database>;

export function stageHighlights(
  stage: TraceStage,
  summary: Record<string, unknown>,
  run: RunDetail | null,
  dataSources: string[],
): string[] {
  const cards = runCards(run);
  const firstCard = cards[0];
  const card = firstCard?.card;
  const title = card ? clipText(cardTitle(card), 140) : "";
  const evaluation = firstCard?.evaluation;

  if (stage === "data-collector") {
    return [
      `写卡前检查了 ${summarizeSources(dataSources)}。`,
      `这个上下文收集步骤关联到 ${stageNodes(summary, stage)} 个链路事件。`,
    ];
  }
  if (stage === "planner") {
    return [
      title ? `本轮选择了「${title}」作为最清晰的卡片想法。` : "本轮选择了最强、且不是重复的想法。",
      `时机理由：${firstSentences(cardWhyNow(card), 220)}`,
    ];
  }
  if (stage === "card-generator") {
    const action = primaryActionLabel(card);
    return [
      title ? `写出了面向用户的卡片「${title}」。` : "把选中的想法写成面向用户的卡片。",
      `卡片摘要：${firstSentences(cardSummary(card), 220)}`,
      action ? `主动作：${action}。` : "",
    ].filter(Boolean).slice(0, 3);
  }
  const hasEvaluatorScore = typeof evaluation?.overall === "number" && Number.isFinite(evaluation.overall);
  return [
    hasEvaluatorScore
      ? `评估器分数：${scoreLabel(evaluation.overall)}（${evaluation.pass ? "通过" : "未通过"}）。`
      : "第一张卡还没有保存评估器分。",
    evaluation?.feedback ? `质量备注：${firstSentences(evaluation.feedback, 220)}` : "第一张卡没有保存评估器备注。",
  ];
}

function stageLabel(stage: TraceStage): string {
  return {
    "data-collector": "收集上下文",
    planner: "选择意图",
    "card-generator": "写出卡片",
    evaluator: "评估结果",
  }[stage] ?? stage;
}

function stageExplanation(stage: TraceStage): string {
  return {
    "data-collector": "把画像、记忆、信号、日历、近期卡片、反馈和外部上下文拉进本轮状态。",
    planner: "过滤重复想法，挑出最及时、最值得写成卡片的意图。",
    "card-generator": "把选中的计划写成带动作和证据引用的用户卡片。",
    evaluator: "在批次落库前给每张卡评分，并解释质量问题。",
  }[stage] ?? "";
}

function evaluatorScoreSummary(evaluation: RunDetail["cards"][number]["evaluation"] | null | undefined): string {
  return typeof evaluation?.overall === "number" && Number.isFinite(evaluation.overall)
    ? `把第一张卡评为 ${scoreLabel(evaluation.overall)} 分`
    : "第一张卡还没有保存评估器分";
}

export function tracePlainSummary(run: RunDetail | null, dataSources: string[], traceStatus: TraceArtifact["status"]): string {
  const cards = runCards(run);
  const firstCard = cards[0];
  if (!firstCard) {
    return "生成器检查可用上下文，过滤重复想法，写出卡片批次，然后在保存前评估结果。";
  }
  const prefix = traceStatus === "ready" ? "本轮生成查看了" : "链路记录缺失，但保存下来的卡片引用了";
  return `${prefix} ${summarizeSources(dataSources)}，选择「${clipText(cardTitle(firstCard.card), 140)}」，写出 ${cards.length} 张卡，然后${evaluatorScoreSummary(firstCard.evaluation)}。`;
}

function checkTone(ok: boolean): "bad" | "good" {
  return ok ? "good" : "bad";
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function traceRecoveryVisible(error: string | null, trace: TraceArtifact | null): boolean {
  return initialLoadRecoveryVisible(error, trace);
}

export function traceCopyUnavailableMessage(markdown: string, busy: boolean): string | null {
  if (busy) return "链路正在刷新，完成后再复制。";
  if (!markdown.trim()) return "当前链路没有可复制摘要。";
  return null;
}

export function TraceView({ runId, onNavigate }: TraceViewProps) {
  const [trace, setTrace] = useState<TraceArtifact | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const traceRef = useRef<TraceArtifact | null>(null);
  const activeTraceRouteRef = useRef(runId);
  activeTraceRouteRef.current = runId;

  useEffect(() => {
    traceRef.current = trace;
  }, [trace]);

  const load = useCallback(async () => {
    const routeRunId = runId;
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setActionMessage(null);
    setError(null);
    try {
      const [traceResult, runResult] = await Promise.allSettled([getTrace(routeRunId), getRun(routeRunId)]);
      if (routeRunId !== activeTraceRouteRef.current || requestId !== requestSeq.current) return;
      if (traceResult.status === "rejected") {
        throw traceResult.reason;
      }
      setTrace(traceResult.value.trace);
      if (runResult.status === "fulfilled") {
        setRun(runResult.value);
      } else {
        setRun(null);
        setActionMessage({
          kind: "error",
          text: `链路已加载，但批次详情加载失败：${errorText(runResult.reason, "加载失败")}`,
        });
      }
      setError(null);
    } catch (err) {
      if (routeRunId === activeTraceRouteRef.current && requestId === requestSeq.current) {
        const message = errorText(err, "加载失败");
        if (traceRef.current) {
          setActionMessage({
            kind: "error",
            text: `链路刷新失败，当前仍显示上一次成功加载的数据：${message}`,
          });
        } else {
          setError(message);
        }
      }
    }
  }, [runId]);

  const rebuild = useCallback(async (force = false) => {
    const routeRunId = runId;
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setBusy(true);
    setActionMessage(null);
    try {
      const traceData = await buildTrace(routeRunId, force);
      if (routeRunId !== activeTraceRouteRef.current || requestId !== requestSeq.current) return;
      setTrace(traceData.trace);
      setError(null);
      try {
        const nextRun = await getRun(routeRunId);
        if (routeRunId !== activeTraceRouteRef.current || requestId !== requestSeq.current) return;
        setRun(nextRun);
        setActionMessage({ kind: "success", text: force ? "链路记录已重建。" : "链路记录已生成。" });
      } catch (runErr) {
        if (routeRunId !== activeTraceRouteRef.current || requestId !== requestSeq.current) return;
        setRun(null);
        setActionMessage({
          kind: "error",
          text: `链路记录已生成，但批次详情加载失败：${errorText(runErr, "加载失败")}`,
        });
      }
    } catch (err) {
      if (routeRunId === activeTraceRouteRef.current && requestId === requestSeq.current) {
        setActionMessage({ kind: "error", text: errorText(err, "生成失败") });
      }
    } finally {
      if (routeRunId === activeTraceRouteRef.current && requestId === requestSeq.current) {
        setBusy(false);
      }
    }
  }, [runId]);

  useEffect(() => {
    setTrace(null);
    traceRef.current = null;
    setRun(null);
    setCopyMessage(null);
    setMarkdownOpen(false);
    setActionMessage(null);
    setBusy(false);
    setError(null);
    void load();
  }, [load, runId]);

  if (traceRecoveryVisible(error, trace)) {
    return (
      <div className="stack">
        <div className="view-toolbar">
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.run(runId))} type="button">
            <ArrowLeft size={16} /> 批次
          </button>
          <div className="toolbar-actions">
            <button className="plain-button" onClick={() => void load()} disabled={busy} type="button">
              <RefreshCw size={16} /> 重新加载
            </button>
            <button className="primary-button" onClick={() => rebuild(true)} disabled={busy} type="button">
              <RefreshCw size={16} /> {busy ? "生成中" : "重建链路记录"}
            </button>
          </div>
        </div>
        {actionMessage && (
          <div
            className={actionMessage.kind === "error" ? "inline-error" : "inline-status"}
            role={actionMessage.kind === "error" ? "alert" : "status"}
          >
            {actionMessage.text}
          </div>
        )}
        <StateBlock title="链路加载失败" detail={error ?? undefined} />
      </div>
    );
  }
  if (!trace) return <StateBlock title="正在加载链路" />;

  const svg = typeof trace.traceTree.svg === "string" ? trace.traceTree.svg : "";
  const traceSvgSrc = traceSvgDataUrl(svg);
  const rawSvgPresent = svg.trim().length > 0;
  const traceSvgReady = traceSvgSrc.length > 0;
  const dataSources = stringList(trace.summary.dataSources);
  const effectiveDataSources = dataSources.length > 0 ? dataSources : inferredDataSources(run);
  const skippedIntents = stringList(trace.summary.skippedIntents);
  const evaluatorVerdicts = stringList(trace.summary.evaluatorVerdicts);
  const missingStages = stringList(trace.summary.missingStages);
  const readableSkipped = readableSkippedLines(skippedIntents).slice(0, 2);
  const readableVerdicts = readableTraceLines(evaluatorVerdicts).slice(0, 2);
  const langsmithUrl = safeExternalHref(trace.langsmithUrl || (
    typeof trace.traceTree.langsmithUrl === "string" ? trace.traceTree.langsmithUrl : ""
  ));
  const cards = runCards(run);
  const firstCard = cards[0];
  const firstCardRouteId = firstDashboardRouteId(firstCard?.card.id);
  const canOpenFirstCard = hasDashboardRouteId(firstCardRouteId);
  const firstCardSources = sourcePreview(firstCard?.card);
  const traceMarkdown = traceReviewMarkdown({
    dataSources: effectiveDataSources,
    routeRunId: runId,
    run,
    trace,
  });
  const copyUnavailableMessage = traceCopyUnavailableMessage(traceMarkdown, busy);
  const traceChecks = [
    {
      detail: trace.status === "ready" ? "可以用于复盘" : clipText(trace.error ?? "需要生成或修复 trace artifact", 420),
      label: "Artifact",
      ok: trace.status === "ready",
      value: traceStatusLabel(trace.status),
    },
    {
      detail: langsmithUrl ? "可跳到 LangSmith 原始 trace" : "缺少可用 LangSmith URL 或 root trace id",
      label: "LangSmith",
      ok: Boolean(langsmithUrl),
      value: langsmithUrl ? "已绑定" : "未绑定",
    },
    {
      detail: traceSvgReady
        ? "确定性图已生成"
        : rawSvgPresent
          ? "SVG 内容未通过安全过滤，仍可看结构化摘要"
          : "没有可渲染 SVG，仍可看结构化摘要",
      label: "Trace 图",
      ok: traceSvgReady,
      value: traceSvgReady ? "已生成" : "未生成",
    },
    {
      detail: missingStages.length > 0 ? missingStages.join(", ") : "四阶段摘要完整",
      label: "阶段完整性",
      ok: missingStages.length === 0,
      value: missingStages.length > 0 ? `${missingStages.length} 个缺失` : "完整",
    },
  ];

  async function copyTraceMarkdown() {
    if (copyUnavailableMessage) {
      setCopyMessage(copyUnavailableMessage);
      return;
    }
    setMarkdownOpen(true);
    const copied = await copyText(traceMarkdown);
    setCopyMessage(copied ? "已复制链路复盘摘要。" : "当前浏览器不支持自动复制，请从页面摘要手动复制。");
  }

  function refreshTraceView() {
    setCopyMessage(null);
    setMarkdownOpen(false);
    void load();
  }

  return (
    <div className="stack">
      <div className="view-toolbar">
        <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.run(runId))} type="button">
          <ArrowLeft size={16} /> 批次
        </button>
        <div className="toolbar-actions">
          {langsmithUrl && (
            <a className="plain-button" href={langsmithUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> LangSmith
            </a>
          )}
          <button className="plain-button" onClick={refreshTraceView} disabled={busy} type="button">
            <RefreshCw size={16} /> 刷新链路
          </button>
          <button className="plain-button" onClick={() => rebuild(true)} disabled={busy} type="button">
            <RefreshCw size={16} /> {busy ? "生成中" : "重建链路记录"}
          </button>
        </div>
      </div>
      {actionMessage && (
        <div
          className={actionMessage.kind === "error" ? "inline-error" : "inline-status"}
          role={actionMessage.kind === "error" ? "alert" : "status"}
        >
          {actionMessage.text}
        </div>
      )}

      <section className="panel trace-hero">
        <div className="panel-head">
          <div>
            <h2>这批卡片是怎么生成的</h2>
            <p>{clipText(runId, 180)}</p>
          </div>
          <span className={`status-pill ${traceStatusClass(trace.status)}`}>{traceStatusLabel(trace.status)}</span>
        </div>
        <div className="trace-hero-grid">
          <div>
            <div className="trace-kicker">白话摘要</div>
            <p className="trace-plain-summary">{tracePlainSummary(run, effectiveDataSources, trace.status)}</p>
          </div>
          <div className="run-context">
            <div><span>生成卡片</span><strong>{run ? cards.length : "-"}</strong></div>
            <div><span>链路 ID</span><strong>{trace.langsmithTraceId ?? "-"}</strong></div>
            <div><span>证据组</span><strong>{effectiveDataSources.length}</strong></div>
          </div>
        </div>
        {trace.status === "missing" && (
          <div className="missing-block">
            <strong>链路记录缺失</strong>
            <p>{clipText(trace.error ?? "没有找到链路记录。", 420)}</p>
            <button className="primary-button" onClick={() => rebuild(false)} disabled={busy} type="button">
              生成链路记录
            </button>
          </div>
        )}
        {trace.status === "failed" && (
          <div className="missing-block failed">
            <strong>链路记录生成失败</strong>
            <p>{clipText(trace.error ?? "链路记录生成失败。", 420)}</p>
            <button className="primary-button" onClick={() => rebuild(true)} disabled={busy} type="button">
              重新生成链路记录
            </button>
          </div>
        )}
        {traceSvgSrc && (
          <div className="trace-svg">
            <img alt="标准化生成链路图" src={traceSvgSrc} />
          </div>
        )}
      </section>

      <section className="trace-check-grid">
        {traceChecks.map((check) => (
          <div className={`trace-check-card ${checkTone(check.ok)}`} key={check.label}>
            <span>{check.label}</span>
            <strong>{check.value}</strong>
            <p>{check.detail}</p>
          </div>
        ))}
      </section>

      <section className="trace-action-grid" aria-label="链路复盘动作">
        <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.run(runId))} type="button">
          <ListChecks size={15} />
          <span>批次评审</span>
        </button>
        <button
          className="plain-button"
          disabled={!canOpenFirstCard}
          onClick={() => onNavigate(dashboardRoutes.card(firstCardRouteId))}
          title={canOpenFirstCard ? "打开首张卡片" : dashboardRouteDisabledReason("card")}
          type="button"
        >
          <Search size={15} />
          <span>首张卡片</span>
        </button>
        <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
          <CheckCircle2 size={15} />
          <span>样本库</span>
        </button>
        <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.personalData)} type="button">
          <Database size={15} />
          <span>上下文</span>
        </button>
        <button
          aria-controls="trace-review-markdown-export"
          aria-expanded={markdownOpen}
          className="plain-button"
          disabled={copyUnavailableMessage !== null}
          onClick={() => void copyTraceMarkdown()}
          title={copyUnavailableMessage ?? "复制链路复盘摘要"}
          type="button"
        >
          <ClipboardCopy size={15} />
          <span>复制摘要</span>
        </button>
      </section>
      {copyMessage && <div className="inline-status" role="status">{copyMessage}</div>}
      {markdownOpen && (
        <textarea
          aria-label="链路复盘 markdown 导出"
          className="markdown-export"
          id="trace-review-markdown-export"
          readOnly
          rows={12}
          value={traceMarkdown}
        />
      )}

      <section className="generation-story">
        {TRACE_STAGES.map((stage, index) => {
          const highlights = stageHighlights(stage, trace.summary, run, effectiveDataSources);
          const StageIcon = STAGE_ICONS[stage];
          return (
            <article className="story-step" key={stage}>
              <div className="story-number"><StageIcon size={17} /></div>
              <div className="story-body">
                <div className="story-head">
                  <div>
                    <div className="story-label">第 {index + 1} 步</div>
                    <h3>{stageLabel(stage)}</h3>
                    <p>{stageExplanation(stage)}</p>
                  </div>
                  <strong>{stageNodes(trace.summary, stage)} 个链路事件</strong>
                </div>
                <ul className="story-highlights">
                  {highlights.map((highlight, highlightIndex) => (
                    <li key={`story-highlight-${highlightIndex}`}><CheckCircle2 size={15} /> {highlight}</li>
                  ))}
                </ul>
              </div>
            </article>
          );
        })}
        {missingStages.length > 0 && (
          <p className="inline-error">缺失阶段：{missingStages.join(", ")}</p>
        )}
      </section>

      <section className="panel trace-decision-panel">
        <div className="panel-head">
          <div>
            <h2>输入和决策</h2>
            <p>把“读了什么”和“为什么这样生成”分开看，先看依据，再看筛选和质量判断。</p>
          </div>
        </div>
        <div className="trace-decision-layout">
          <section className="trace-column input">
            <div className="trace-column-head">
              <span><Database size={17} /></span>
              <div>
                <div className="section-kicker">输入</div>
                <h3>进入本轮的上下文</h3>
              </div>
              <strong>{effectiveDataSources.length} 组</strong>
            </div>
            <div className="source-inventory">
              {(effectiveDataSources.length > 0 ? effectiveDataSources : ["无"]).map((source, sourceIndex) => (
                <span key={`${sourceIndex}:data-source`}>{sourceLabel(source)}</span>
              ))}
            </div>
            <div className="trace-evidence-block">
              <h4>卡片背后的证据</h4>
              <div className="evidence-stack refined">
                {(firstCardSources.length > 0 ? firstCardSources.slice(0, 5) : ["没有保存卡片证据引用。"]).map((source, sourceIndex) => (
                  <p key={`${sourceIndex}:card-source`}>{clipText(source, 280)}</p>
                ))}
              </div>
            </div>
          </section>

          <section className="trace-column decision">
            <div className="trace-column-head">
              <span><Filter size={17} /></span>
              <div>
                <div className="section-kicker">决策</div>
                <h3>规划器和评估器判断</h3>
              </div>
              <strong>{cards.length} 张</strong>
            </div>
            <div className="trace-decision-card primary">
              <span>为什么会生成第一张卡</span>
              <p>{firstSentences(cardWhyNow(firstCard?.card), 340)}</p>
            </div>
            <div className="trace-decision-split">
              <div className="trace-decision-card">
                <span>写卡前过滤</span>
                <ul className="trace-list clean">
                  {(readableSkipped.length > 0 ? readableSkipped : ["重复或近期已展示过的想法在写卡前被压掉。"]).map((item, itemIndex) => (
                    <li key={`skipped-intent-${itemIndex}`}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="trace-decision-card">
                <span>质量检查</span>
                <ul className="trace-list clean">
                  {(readableVerdicts.length > 0 ? readableVerdicts : [firstCard?.evaluation?.feedback ? firstSentences(firstCard.evaluation.feedback, 320) : "没有评估器结论摘要。"]).map((item, itemIndex) => (
                    <li key={`evaluator-verdict-${itemIndex}`}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </div>
      </section>

      {run && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>本轮生成的卡片</h2>
              <p>打开卡片可以查看证据、评估器判断、用户反馈、奖励事件和样本备注。</p>
            </div>
          </div>
          <div className="trace-card-list">
            {cards.map((entry, index) => {
              const cardRouteId = firstDashboardRouteId(entry.card.id);
              const canOpenCard = hasDashboardRouteId(cardRouteId);
              return (
                <button
                  className="trace-card-item"
                  disabled={!canOpenCard}
                  key={`${index}:${entry.card.id}`}
                  onClick={() => onNavigate(dashboardRoutes.card(cardRouteId))}
                  title={canOpenCard ? "打开卡片详情" : dashboardRouteDisabledReason("card")}
                  type="button"
                >
                  <div>
                    <h3>{clipText(cardTitle(entry.card), 160)}</h3>
                    <p>{cardSummary(entry.card)}</p>
                  </div>
                  <div className="score-pair compact-score">
                    <div><span>人工</span><strong>{scoreLabel(entry.rewards.reviewerReward)}</strong></div>
                    <div><span>评估</span><strong>{scoreLabel(entry.evaluation?.overall)}</strong></div>
                  </div>
                  <Search size={16} />
                </button>
              );
            })}
            {cards.length === 0 && <div className="muted">没有保存卡片。</div>}
          </div>
        </section>
      )}

      <section className="panel compact">
        <details className="raw-details">
          <summary>原始标准化链路数据</summary>
          <pre className="json-block">{redactedJsonString(trace.summary)}</pre>
        </details>
      </section>
    </div>
  );
}
