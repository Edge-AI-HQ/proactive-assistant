import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { buildEvaluatorWorkerPrompt, buildFeedbackSynthPrompt } from "../agents/evaluator.js";
import { buildGeneratorPrompt } from "../agents/generator.js";
import { buildPlannerPrompt } from "../agents/planner.js";
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from "../generation-language.js";
import type {
  EvaluationScore,
  EvaluatorOutput,
  GeneratorOutput,
  IntentCard,
  PipelineIteration,
  PipelineResult,
  PlannerOutput,
  ServerEvent,
} from "../../core/index.js";
import { buildContextBrief, type ContextBrief } from "./context-builder.js";
import { buildIntentEvidencePacks, type IntentEvidencePack } from "./evidence-builder.js";
import { mapWithConcurrency, runRuleValidators } from "./evaluation.js";
import {
  detectAgentErrorInMessages,
  parseAgentJson,
  parseAgentJsonOrThrow,
} from "./agent-output.js";
import {
  formatRecentFeedbackSummary,
  loadRecentFeedbackSummary,
} from "./feedback-summary.js";
import { buildDefaultCtx } from "./data-access.js";
import {
  appendRunTraceEvent,
  collectGatewayAnomalies,
  estimateTokenCount,
  getRunTracePath,
  type PipelineTracePayload,
  type TraceEventRecord,
} from "./trace.js";

export interface PipelineOptions {
  maxIterations: number;
  agentTimeoutMs: number;
  runId?: string;
  outputLanguage?: SupportedGenerationLanguage;
  incrementalContext?: string;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  maxIterations: 2,
  agentTimeoutMs: 300_000,
  outputLanguage: DEFAULT_GENERATION_LANGUAGE,
};

type EventSink = (event: ServerEvent) => void;
type TimingEmitter = (label: string, durationMs: number, detail?: string) => void;

interface ScoredCandidate {
  card: IntentCard;
  score: EvaluationScore;
  iteration: number;
}

interface IterationContext {
  feedback: string;
  plan: PlannerOutput;
  cards: IntentCard[];
  scores: EvaluationScore[];
}

interface EvaluatorWorkerOutput {
  overall: number;
  dimensions: EvaluationScore["dimensions"];
  feedback: string;
  pass: boolean;
}

interface FeedbackSynthOutput {
  iterationFeedback: string;
}

export async function runPipeline(
  api: OpenClawPluginApi,
  opts: PipelineOptions = DEFAULT_PIPELINE_OPTIONS,
  onEvent?: EventSink,
): Promise<PipelineResult> {
  const emit = onEvent ?? (() => {});
  const currentDate = new Date().toISOString().slice(0, 10);
  const outputLanguage = opts.outputLanguage ?? DEFAULT_GENERATION_LANGUAGE;
  const runId = opts.runId ?? `run_${Date.now().toString(36)}`;
  const traceRuntime = buildDefaultCtx();
  const tracePath = getRunTracePath(traceRuntime, runId);
  const startedAt = new Date().toISOString();

  const iterations: PipelineIteration[] = [];
  const candidatePool: ScoredCandidate[] = [];
  const pendingTraceWrites: Array<Promise<void>> = [];
  let recentFeedbackSummary = "";
  let contextBrief: ContextBrief | null = null;
  let prev: IterationContext | undefined;
  const pipelineT0 = Date.now();

  const recordTrace = (payload: PipelineTracePayload): void => {
    const timestamp = payload.timestamp ?? new Date().toISOString();
    const message = payload.message ?? buildTraceMessage(payload);
    emit({
      type: "pipeline:trace",
      data: {
        iteration: payload.iteration,
        phase: payload.phase,
        kind: payload.kind,
        name: payload.name,
        durationMs: payload.durationMs,
        message,
        attrs: payload.attrs,
      },
    });
    pendingTraceWrites.push(
      appendRunTraceEvent(traceRuntime, runId, {
        timestamp,
        iteration: payload.iteration,
        phase: payload.phase,
        kind: payload.kind,
        name: payload.name,
        durationMs: payload.durationMs,
        message,
        attrs: payload.attrs,
      }).catch(() => {}),
    );
  };

  const recordTraceOnly = (event: TraceEventRecord): void => {
    pendingTraceWrites.push(
      appendRunTraceEvent(traceRuntime, runId, event).catch(() => {}),
    );
  };

  const emitTiming: TimingEmitter = (label, durationMs, detail) => {
    const seconds = (durationMs / 1000).toFixed(1);
    const message = detail ? `${label} ${seconds}s (${detail})` : `${label} ${seconds}s`;
    api.logger.info(`[timing] ${message}`);
    emit({ type: "pipeline:timing", data: { label, durationMs, detail: message } });
    recordTraceOnly({
      timestamp: new Date().toISOString(),
      phase: "timing",
      kind: "timing",
      name: label,
      durationMs,
      message,
    });
  };

  emit({ type: "pipeline:start", data: { maxIterations: opts.maxIterations } });

  const feedbackT0 = Date.now();
  try {
    recentFeedbackSummary = formatRecentFeedbackSummary(
      await loadRecentFeedbackSummary({ since: "14d" }),
    );
  } catch (error) {
    api.logger.warn(
      `Failed to load recent feedback summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  emitTiming("Feedback prefetch", Date.now() - feedbackT0);

  const contextT0 = Date.now();
  contextBrief = await buildContextBrief({
    incrementalContext: opts.incrementalContext,
    onTrace(event) {
      const payload: PipelineTracePayload = {
        iteration: event.iteration,
        phase: event.phase,
        kind: event.kind,
        name: event.name,
        durationMs: event.durationMs,
        message: event.message ?? buildTraceMessageFromContextEvent(event),
        attrs: event.attrs,
      };
      recordTrace(payload);
    },
  });
  emitTiming("Context build total", Date.now() - contextT0);

  for (let i = 1; i <= opts.maxIterations; i += 1) {
    const iterationT0 = Date.now();
    api.logger.info(`Pipeline iteration ${i}/${opts.maxIterations}`);

    emit({ type: "pipeline:iteration", data: { iteration: i, phase: "planning" } });

    const plannerPrompt = buildPlannerPrompt({
      currentDate,
      iterationNumber: i,
      contextBrief: JSON.stringify(contextBrief, null, 2),
      recentFeedbackSummary,
      previousIterationDelta: prev ? JSON.stringify(buildPreviousIterationDelta(prev), null, 2) : undefined,
      outputLanguage,
    });
    recordPromptStats(recordTrace, {
      iteration: i,
      phase: "planner",
      name: `planner:${i}`,
      prompt: plannerPrompt,
      objectCounts: {
        contextSources: countContextSources(contextBrief),
        previousCards: prev?.cards.length ?? 0,
        previousScores: prev?.scores.length ?? 0,
      },
    });

    const plannerT0 = Date.now();
    const planText = await runAgent(
      api,
      `plan:${i}`,
      plannerPrompt,
      "Generate an intent card plan based on the prepared context brief.",
      opts.agentTimeoutMs,
      emitTiming,
    );
    emitTiming(`Planner:${i} total`, Date.now() - plannerT0);
    const plan = parseAgentJsonOrThrow<PlannerOutput>(planText, `plan:${i}`);
    if (!plan.intentsToGenerate?.length) {
      api.logger.warn(`Planner iteration ${i} produced no intents, stopping`);
      break;
    }

    const evidenceT0 = Date.now();
    const evidencePacks = await buildIntentEvidencePacks({
      contextBrief,
      plan,
      onTrace(event) {
        recordTrace({
          phase: event.phase,
          kind: event.kind,
          name: event.name,
          durationMs: event.durationMs,
          attrs: event.attrs,
          message: buildTraceMessage(event),
        });
      },
    });
    emitTiming("Evidence build total", Date.now() - evidenceT0);

    emit({ type: "pipeline:iteration", data: { iteration: i, phase: "generating" } });

    const generatorPrompt = buildGeneratorPrompt({
      currentDate,
      plan: JSON.stringify(plan, null, 2),
      evidencePacks: JSON.stringify(evidencePacks, null, 2),
      iterationNumber: i,
      previousIterationDelta: prev ? JSON.stringify(buildPreviousIterationDelta(prev), null, 2) : undefined,
      recentFeedbackSummary,
      outputLanguage,
    });
    recordPromptStats(recordTrace, {
      iteration: i,
      phase: "generator",
      name: `generator:${i}`,
      prompt: generatorPrompt,
      objectCounts: {
        intents: plan.intentsToGenerate.length,
        evidencePacks: evidencePacks.length,
        evidenceFacts: evidencePacks.reduce((sum, pack) => sum + pack.facts.length, 0),
      },
    });

    const generatorT0 = Date.now();
    const cardsText = await runAgent(
      api,
      `generate:${i}`,
      generatorPrompt,
      "Generate intent cards from the plan and evidence packs.",
      opts.agentTimeoutMs,
      emitTiming,
    );
    emitTiming(`Generator:${i} total`, Date.now() - generatorT0);
    const generated = parseAgentJsonOrThrow<GeneratorOutput>(cardsText, `generate:${i}`);
    if (!generated.cards?.length) {
      api.logger.warn(`Generator iteration ${i} produced no cards, stopping`);
      break;
    }

    emit({ type: "pipeline:cards", data: { iteration: i, cards: generated.cards } });
    emit({ type: "pipeline:iteration", data: { iteration: i, phase: "evaluating" } });

    const packsByCardId = mapEvidencePacksToCards(generated.cards, evidencePacks);
    const validatorResults = runRuleValidators(generated.cards, packsByCardId);
    for (const [cardId, result] of Object.entries(validatorResults)) {
      recordTrace({
        iteration: i,
        phase: "evaluating",
        kind: "validator.result",
        name: cardId,
        message: result.issues.length
          ? result.issues.map((issue) => issue.code).join(", ")
          : "validator clean",
        attrs: {
          issues: result.issues,
        },
      });
    }

    const evaluatorT0 = Date.now();
    const evaluations = await mapWithConcurrency(generated.cards, 3, async (card, index) => {
      const evidencePack = packsByCardId[card.id] ?? fallbackEvidencePack(card, evidencePacks[index]);
      const traceName = `evaluator:${i}:${card.id}`;
      recordTrace({
        iteration: i,
        phase: "evaluating",
        kind: "evaluator.worker.start",
        name: traceName,
        message: `Start evaluating ${card.id}`,
      });

      const workerPrompt = buildEvaluatorWorkerPrompt({
        currentDate,
        iterationNumber: i,
        maxIterations: opts.maxIterations,
        plan: JSON.stringify(plan, null, 2),
        card: JSON.stringify(card, null, 2),
        evidencePack: JSON.stringify(evidencePack, null, 2),
        validatorSummary: JSON.stringify(validatorResults[card.id] ?? { cardId: card.id, issues: [] }, null, 2),
        outputLanguage,
      });
      recordPromptStats(recordTrace, {
        iteration: i,
        phase: "evaluating",
        name: traceName,
        prompt: workerPrompt,
        objectCounts: {
          cardSources: card.sources.length,
          evidenceRefs: evidencePack.evidenceRefs.length,
          validatorIssues: validatorResults[card.id]?.issues.length ?? 0,
        },
      });

      const workerT0 = Date.now();
      try {
        const text = await runAgent(
          api,
          `evaluate:${i}:${card.id}`,
          workerPrompt,
          `Evaluate the generated card ${card.id}.`,
          opts.agentTimeoutMs,
          emitTiming,
        );
        const parsed = parseAgentJson<EvaluatorWorkerOutput>(text);
        const score = toEvaluationScore(card.id, parsed, validatorResults[card.id]);
        emitTiming(`Evaluator worker:${card.id}`, Date.now() - workerT0);
        recordTrace({
          iteration: i,
          phase: "evaluating",
          kind: "evaluator.worker.finish",
          name: traceName,
          durationMs: Date.now() - workerT0,
          message: `overall=${score.overall.toFixed(1)} pass=${String(score.pass)}`,
          attrs: {
            overall: score.overall,
            pass: score.pass,
          },
        });
        return score;
      } catch (error) {
        const score = syntheticScore(card.id, `Evaluator worker failed: ${error instanceof Error ? error.message : String(error)}`);
        emitTiming(`Evaluator worker:${card.id}`, Date.now() - workerT0);
        recordTrace({
          iteration: i,
          phase: "evaluating",
          kind: "evaluator.worker.finish",
          name: traceName,
          durationMs: Date.now() - workerT0,
          message: score.feedback,
          attrs: {
            overall: score.overall,
            pass: score.pass,
            error: true,
          },
        });
        return score;
      }
    });

    const feedbackSynthT0 = Date.now();
    const feedbackPrompt = buildFeedbackSynthPrompt({
      currentDate,
      iterationNumber: i,
      maxIterations: opts.maxIterations,
      evaluations: JSON.stringify(evaluations, null, 2),
      validatorSummary: JSON.stringify(validatorResults, null, 2),
      outputLanguage,
    });
    recordPromptStats(recordTrace, {
      iteration: i,
      phase: "evaluating",
      name: `feedback:${i}`,
      prompt: feedbackPrompt,
      objectCounts: {
        evaluations: evaluations.length,
        validatorEntries: Object.keys(validatorResults).length,
      },
    });

    let iterationFeedback = buildFallbackIterationFeedback(evaluations, validatorResults);
    try {
      const text = await runAgent(
        api,
        `feedback:${i}`,
        feedbackPrompt,
        "Summarize the evaluation feedback for the next pipeline iteration.",
        opts.agentTimeoutMs,
        emitTiming,
      );
      const parsed = parseAgentJson<FeedbackSynthOutput>(text);
      if (parsed?.iterationFeedback?.trim()) {
        iterationFeedback = parsed.iterationFeedback.trim();
      }
    } catch (error) {
      api.logger.warn(`Feedback synth failed for iteration ${i}: ${error instanceof Error ? error.message : String(error)}`);
    }
    emitTiming("Feedback synth total", Date.now() - feedbackSynthT0);
    emitTiming(`Evaluator:${i} total`, Date.now() - evaluatorT0);

    const evaluation: EvaluatorOutput = {
      evaluations,
      bestCards: selectIterationBestCards(generated.cards, evaluations),
      iterationFeedback,
    };

    emit({ type: "pipeline:evaluation", data: { iteration: i, evaluation } });

    for (const card of generated.cards) {
      const score = evaluations.find((entry) => entry.cardId === card.id) ?? syntheticScore(card.id);
      candidatePool.push({ card, score, iteration: i });
    }

    prev = {
      feedback: iterationFeedback,
      plan,
      cards: generated.cards,
      scores: evaluations,
    };

    iterations.push({
      iteration: i,
      plan,
      cards: generated.cards,
      evaluation,
    });

    emitTiming(`Iteration ${i} total`, Date.now() - iterationT0);

    if (evaluations.length > 0 && evaluations.every((score) => score.overall >= 8.5)) {
      api.logger.info(`All cards scored >= 8.5 at iteration ${i}, stopping early`);
      break;
    }
  }

  const selectionT0 = Date.now();
  const finalCards = selectBestCards(candidatePool);
  emitTiming("Candidate selection", Date.now() - selectionT0);
  emitTiming("Pipeline total", Date.now() - pipelineT0);

  const endedAt = new Date().toISOString();
  const anomalies = await collectGatewayAnomalies({
    runId,
    startedAt,
    endedAt,
  });
  for (const anomaly of anomalies) {
    recordTrace({
      phase: anomaly.phase,
      kind: anomaly.kind,
      name: anomaly.name,
      durationMs: anomaly.durationMs,
      message: anomaly.message ?? String(anomaly.attrs?.message ?? anomaly.name),
      attrs: anomaly.attrs,
    });
  }

  recordTrace({
    phase: "pipeline",
    kind: "pipeline.summary",
    name: "Pipeline summary",
    durationMs: Date.now() - pipelineT0,
    message: `iterations=${iterations.length}, finalCards=${finalCards.length}, anomalies=${anomalies.length}`,
    attrs: {
      iterations: iterations.length,
      finalCards: finalCards.length,
      anomalies: anomalies.length,
      tracePath,
    },
  });

  await Promise.all(pendingTraceWrites);

  const result: PipelineResult = {
    runId,
    iterations,
    finalCards,
    totalIterations: iterations.length,
    tracePath,
  };

  emit({ type: "pipeline:complete", data: result });
  return result;
}

function buildTraceMessage(payload: {
  name: string;
  kind: string;
  durationMs?: number;
  attrs?: Record<string, unknown>;
  message?: string;
}): string {
  if (payload.message) return payload.message;
  if (payload.kind === "context.summary") {
    const profileExists = payload.attrs?.profileExists ? "ready" : "missing";
    const shortlistCount = payload.attrs?.shortlistCount ?? 0;
    return `profile ${profileExists}, world shortlist ${String(shortlistCount)}`;
  }
  if (typeof payload.durationMs === "number") {
    return `${payload.name} ${(payload.durationMs / 1000).toFixed(1)}s`;
  }
  return payload.name;
}

function buildTraceMessageFromContextEvent(event: TraceEventRecord): string {
  if (event.kind === "context.summary") {
    return buildTraceMessage(event);
  }
  if (event.kind === "context.source.finish") {
    const count = typeof event.attrs?.count === "number" ? event.attrs.count : 0;
    return `${event.name} ready (${count})`;
  }
  if (event.kind === "context.source.start") {
    return `Loading ${event.name}`;
  }
  return buildTraceMessage(event);
}

function countContextSources(contextBrief: ContextBrief): number {
  return [
    contextBrief.profileStatus.exists ? 1 : 0,
    contextBrief.personalStatus.connectedCount,
    contextBrief.worldStatus.shortlistCount,
    contextBrief.recentSignals.incremental.world.length,
    contextBrief.recentSignals.incremental.personal.length,
  ].reduce((sum, value) => sum + value, 0);
}

function recordPromptStats(
  recordTrace: (payload: PipelineTracePayload) => void,
  input: {
    iteration?: number;
    phase: string;
    name: string;
    prompt: string;
    objectCounts: Record<string, number>;
  },
): void {
  const chars = input.prompt.length;
  const estimatedTokens = estimateTokenCount(input.prompt);
  recordTrace({
    iteration: input.iteration,
    phase: input.phase,
    kind: "agent.prompt_stats",
    name: `Prompt stats:${input.name}`,
    message: `chars=${chars}, tokens≈${estimatedTokens}`,
    attrs: {
      chars,
      estimatedTokens,
      objectCounts: input.objectCounts,
    },
  });
}

function buildPreviousIterationDelta(prev: IterationContext): Record<string, unknown> {
  const weakDimensions = {
    relevance: 0,
    actionability: 0,
    whyNowClarity: 0,
    novelty: 0,
    decisionCompression: 0,
  };

  const cardSummaries = prev.cards.map((card) => {
    const score = prev.scores.find((entry) => entry.cardId === card.id);
    if (score) {
      for (const [dimension, value] of Object.entries(score.dimensions)) {
        if (typeof value === "number" && value < 7) {
          weakDimensions[dimension as keyof typeof weakDimensions] += 1;
        }
      }
    }

    return {
      cardId: card.id,
      title: card.title,
      overall: score?.overall ?? null,
      pass: score?.pass ?? false,
      feedback: score?.feedback ?? "No evaluation available",
    };
  });

  return {
    iterationFeedback: prev.feedback,
    weakDimensions,
    cards: cardSummaries,
  };
}

function mapEvidencePacksToCards(
  cards: IntentCard[],
  evidencePacks: IntentEvidencePack[],
): Record<string, IntentEvidencePack> {
  return Object.fromEntries(
    cards.map((card, index) => [card.id, fallbackEvidencePack(card, evidencePacks[index])]),
  );
}

function fallbackEvidencePack(card: IntentCard, pack?: IntentEvidencePack): IntentEvidencePack {
  if (pack) return pack;
  return {
    intentIndex: 0,
    goalBasket: card.goalBasket,
    objective: card.title,
    whyNow: card.whyNow,
    expectedAction: card.primaryAction.label,
    evidenceRefs: card.sources,
    contextGaps: [],
    facts: [],
  };
}

function toEvaluationScore(
  cardId: string,
  parsed: EvaluatorWorkerOutput | null,
  validatorResult?: { issues: Array<{ code: string; severity: string }> },
): EvaluationScore {
  if (!parsed) {
    return syntheticScore(cardId, "Evaluator worker returned invalid JSON");
  }

  const average = (
    parsed.dimensions.relevance
    + parsed.dimensions.actionability
    + parsed.dimensions.whyNowClarity
    + parsed.dimensions.novelty
    + parsed.dimensions.decisionCompression
  ) / 5;
  const penalty = validatorResult?.issues.reduce((sum, issue) => (
    sum + (issue.severity === "error" ? 0.4 : 0.2)
  ), 0) ?? 0;
  const overall = Math.max(0, Math.min(10, average - penalty));

  return {
    cardId,
    overall,
    dimensions: parsed.dimensions,
    feedback: parsed.feedback,
    pass: parsed.pass && overall >= PASS_THRESHOLD,
  };
}

function buildFallbackIterationFeedback(
  evaluations: EvaluationScore[],
  validatorResults: Record<string, { issues: Array<{ code: string }> }>,
): string {
  const failed = evaluations.filter((entry) => !entry.pass).map((entry) => entry.cardId);
  const validatorIssues = Object.values(validatorResults).flatMap((entry) => entry.issues.map((issue) => issue.code));
  return [
    failed.length ? `Failed cards: ${failed.join(", ")}` : "No failed cards.",
    validatorIssues.length ? `Validator issues: ${[...new Set(validatorIssues)].join(", ")}` : "Validators were clean.",
  ].join(" ");
}

function selectIterationBestCards(cards: IntentCard[], scores: EvaluationScore[]): IntentCard[] {
  const scored = cards
    .map((card) => ({
      card,
      score: scores.find((entry) => entry.cardId === card.id) ?? syntheticScore(card.id),
    }))
    .filter((entry) => entry.score.pass)
    .sort((left, right) => right.score.overall - left.score.overall);

  return scored.map((entry) => entry.card);
}

const MAX_FINAL_CARDS = 10;
const MAX_PER_BASKET = 3;
const PASS_THRESHOLD = 5.0;

function selectBestCards(pool: ScoredCandidate[]): IntentCard[] {
  if (pool.length === 0) return [];

  const deduped = deduplicateByIntent(pool);
  const sorted = [...deduped].sort((a, b) => b.score.overall - a.score.overall);

  let selected = pickWithDiversity(sorted.filter((candidate) => candidate.score.pass && candidate.score.overall >= PASS_THRESHOLD));
  if (selected.length === 0) {
    selected = pickWithDiversity(sorted);
  }

  return selected;
}

function deduplicateByIntent(pool: ScoredCandidate[]): ScoredCandidate[] {
  const kept: ScoredCandidate[] = [];

  for (const candidate of pool) {
    const existingIndex = kept.findIndex(
      (entry) => entry.card.goalBasket === candidate.card.goalBasket
        && titleSimilarity(entry.card.title, candidate.card.title) >= 0.4,
    );

    if (existingIndex === -1) {
      kept.push(candidate);
    } else if (candidate.score.overall > kept[existingIndex]!.score.overall) {
      kept[existingIndex] = candidate;
    }
  }

  return kept;
}

function titleSimilarity(left: string, right: string): number {
  const wordsLeft = new Set(left.toLowerCase().split(/\W+/).filter((word) => word.length > 2));
  const wordsRight = new Set(right.toLowerCase().split(/\W+/).filter((word) => word.length > 2));
  if (wordsLeft.size === 0 || wordsRight.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsLeft) {
    if (wordsRight.has(word)) intersection += 1;
  }

  return intersection / (wordsLeft.size + wordsRight.size - intersection);
}

function pickWithDiversity(candidates: ScoredCandidate[]): IntentCard[] {
  const result: IntentCard[] = [];
  const basketCount = new Map<string, number>();

  for (const { card } of candidates) {
    if (result.length >= MAX_FINAL_CARDS) break;
    const count = basketCount.get(card.goalBasket) ?? 0;
    if (count >= MAX_PER_BASKET) continue;
    result.push(card);
    basketCount.set(card.goalBasket, count + 1);
  }

  return result;
}

function syntheticScore(cardId: string, feedback = "No evaluation available — using default score"): EvaluationScore {
  return {
    cardId,
    overall: 7.0,
    dimensions: {
      relevance: 7,
      actionability: 7,
      whyNowClarity: 7,
      novelty: 7,
      decisionCompression: 7,
    },
    feedback,
    pass: true,
  };
}

async function runAgent(
  api: OpenClawPluginApi,
  tag: string,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number,
  emitTiming?: TimingEmitter,
): Promise<string> {
  const sessionKey = `agent:main:proactive-ai:${tag}:${Date.now().toString(36)}`;

  const dispatchT0 = Date.now();
  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: systemPrompt,
    idempotencyKey: `proactive-ai:${tag}:${Date.now().toString(36)}`,
    message: userMessage,
    deliver: false,
  });
  const dispatchMs = Date.now() - dispatchT0;

  const waitT0 = Date.now();
  const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs });
  const waitMs = Date.now() - waitT0;

  if (result.status !== "ok") {
    throw new Error(`Agent ${tag} failed with status: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
  }

  const fetchT0 = Date.now();
  const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
  const fetchMs = Date.now() - fetchT0;

  emitTiming?.(
    `${tag} breakdown`,
    dispatchMs + waitMs + fetchMs,
    `dispatch: ${(dispatchMs / 1000).toFixed(1)}s, wait: ${(waitMs / 1000).toFixed(1)}s, fetch: ${(fetchMs / 1000).toFixed(1)}s`,
  );

  const messageError = detectAgentErrorInMessages(messages.messages);
  if (messageError) {
    throw new Error(`Agent ${tag} failed: ${messageError}`);
  }
  return extractAgentText(messages);
}

function extractAgentText(messages: { messages: unknown[] }): string {
  const assistantMessages = (messages.messages as Array<{ role?: string; content?: unknown }>)
    .filter((message) => message.role === "assistant");
  const last = assistantMessages[assistantMessages.length - 1];

  if (!last?.content) return "";
  if (typeof last.content === "string") return last.content.trim();
  if (Array.isArray(last.content)) {
    return (last.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n")
      .trim();
  }
  return "";
}
