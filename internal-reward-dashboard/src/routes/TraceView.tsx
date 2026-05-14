import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Database, ExternalLink, FileText, Filter, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { buildTrace, cardTitle, getRun, getTrace, scoreLabel } from "@/api/reward";
import type { RunDetail, TraceArtifact } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
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
  sourceLabel,
  sourcePreview,
  stageNodes,
  stringList,
  summarizeSources,
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

function stageHighlights(
  stage: TraceStage,
  summary: Record<string, unknown>,
  run: RunDetail | null,
  dataSources: string[],
): string[] {
  const firstCard = run?.cards[0];
  const card = firstCard?.card;
  const title = card ? cardTitle(card) : "";
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
  return [
    `评估器分数：${scoreLabel(evaluation?.overall)}${evaluation ? `（${evaluation.pass ? "通过" : "未通过"}）` : ""}。`,
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

function plainSummary(run: RunDetail | null, dataSources: string[], traceStatus: TraceArtifact["status"]): string {
  const firstCard = run?.cards[0];
  if (!firstCard) {
    return "生成器检查可用上下文，过滤重复想法，写出卡片批次，然后在保存前评估结果。";
  }
  const prefix = traceStatus === "ready" ? "本轮生成查看了" : "链路记录缺失，但保存下来的卡片引用了";
  return `${prefix} ${summarizeSources(dataSources)}，选择「${cardTitle(firstCard.card)}」，写出 ${run.cards.length} 张卡，然后把第一张卡评为 ${scoreLabel(firstCard.evaluation?.overall)} 分。`;
}

export function TraceView({ runId, onNavigate }: TraceViewProps) {
  const [trace, setTrace] = useState<TraceArtifact | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [traceData, runData] = await Promise.all([getTrace(runId), getRun(runId)]);
      setTrace(traceData.trace);
      setRun(runData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [runId]);

  const rebuild = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const traceData = await buildTrace(runId, force);
      setTrace(traceData.trace);
      setRun(await getRun(runId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, runId]);

  if (error) return <StateBlock title="链路加载失败" detail={error} />;
  if (!trace) return <StateBlock title="正在加载链路" />;

  const svg = typeof trace.traceTree.svg === "string" ? trace.traceTree.svg : "";
  const dataSources = stringList(trace.summary.dataSources);
  const effectiveDataSources = dataSources.length > 0 ? dataSources : inferredDataSources(run);
  const skippedIntents = stringList(trace.summary.skippedIntents);
  const evaluatorVerdicts = stringList(trace.summary.evaluatorVerdicts);
  const missingStages = stringList(trace.summary.missingStages);
  const readableSkipped = readableSkippedLines(skippedIntents).slice(0, 2);
  const readableVerdicts = readableTraceLines(evaluatorVerdicts).slice(0, 2);
  const langsmithUrl = trace.langsmithUrl || (
    typeof trace.traceTree.langsmithUrl === "string" ? trace.traceTree.langsmithUrl : ""
  );
  const firstCard = run?.cards[0];
  const firstCardSources = sourcePreview(firstCard?.card);

  return (
    <div className="stack">
      <div className="view-toolbar">
        <button className="plain-button" onClick={() => onNavigate(`/runs/${runId}`)}>
          <ArrowLeft size={16} /> 批次
        </button>
        <div className="toolbar-actions">
          {langsmithUrl && (
            <a className="plain-button" href={langsmithUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> LangSmith
            </a>
          )}
          <button className="plain-button" onClick={() => rebuild(true)} disabled={busy}>
            <RefreshCw size={16} /> {busy ? "生成中" : "重建链路记录"}
          </button>
        </div>
      </div>

      <section className="panel trace-hero">
        <div className="panel-head">
          <div>
            <h2>这批卡片是怎么生成的</h2>
            <p>{runId}</p>
          </div>
          <span className={`status-pill ${trace.status}`}>{traceStatusLabel(trace.status)}</span>
        </div>
        <div className="trace-hero-grid">
          <div>
            <div className="trace-kicker">白话摘要</div>
            <p className="trace-plain-summary">{plainSummary(run, effectiveDataSources, trace.status)}</p>
          </div>
          <div className="run-context">
            <div><span>生成卡片</span><strong>{run?.cards.length ?? "-"}</strong></div>
            <div><span>链路 ID</span><strong>{trace.langsmithTraceId ?? "-"}</strong></div>
            <div><span>证据组</span><strong>{effectiveDataSources.length}</strong></div>
          </div>
        </div>
        {trace.status === "missing" && (
          <div className="missing-block">
            <strong>链路记录缺失</strong>
            <p>{trace.error ?? "没有找到链路记录。"}</p>
            <button className="primary-button" onClick={() => rebuild(false)} disabled={busy}>
              生成链路记录
            </button>
          </div>
        )}
        {trace.status === "failed" && (
          <div className="missing-block failed">
            <strong>链路记录生成失败</strong>
            <p>{trace.error ?? "链路记录生成失败。"}</p>
          </div>
        )}
        {svg && <div className="trace-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      </section>

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
                  {highlights.map((highlight) => <li key={highlight}><CheckCircle2 size={15} /> {highlight}</li>)}
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
              {(effectiveDataSources.length > 0 ? effectiveDataSources : ["无"]).map((source) => (
                <span key={source}>{sourceLabel(source)}</span>
              ))}
            </div>
            <div className="trace-evidence-block">
              <h4>卡片背后的证据</h4>
              <div className="evidence-stack refined">
                {(firstCardSources.length > 0 ? firstCardSources.slice(0, 5) : ["没有保存卡片证据引用。"]).map((source) => (
                  <p key={source}>{clipText(source, 280)}</p>
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
              <strong>{run?.cards.length ?? 0} 张</strong>
            </div>
            <div className="trace-decision-card primary">
              <span>为什么会生成第一张卡</span>
              <p>{firstSentences(cardWhyNow(firstCard?.card), 340)}</p>
            </div>
            <div className="trace-decision-split">
              <div className="trace-decision-card">
                <span>写卡前过滤</span>
                <ul className="trace-list clean">
                  {(readableSkipped.length > 0 ? readableSkipped : ["重复或近期已展示过的想法在写卡前被压掉。"]).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="trace-decision-card">
                <span>质量检查</span>
                <ul className="trace-list clean">
                  {(readableVerdicts.length > 0 ? readableVerdicts : [firstCard?.evaluation?.feedback ? firstSentences(firstCard.evaluation.feedback, 320) : "没有评估器结论摘要。"]).map((item) => (
                    <li key={item}>{item}</li>
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
            {run.cards.map((entry) => (
              <button
                className="trace-card-item"
                key={entry.card.id}
                onClick={() => onNavigate(`/cards/${entry.card.id}`)}
              >
                <div>
                  <h3>{cardTitle(entry.card)}</h3>
                  <p>{entry.card.summary ?? ""}</p>
                </div>
                <div className="score-pair compact-score">
                  <div><span>人工</span><strong>{scoreLabel(entry.rewards.reviewerReward)}</strong></div>
                  <div><span>评估</span><strong>{scoreLabel(entry.evaluation?.overall)}</strong></div>
                </div>
                <Search size={16} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="panel compact">
        <details className="raw-details">
          <summary>原始标准化链路数据</summary>
          <pre className="json-block">{JSON.stringify(trace.summary, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
