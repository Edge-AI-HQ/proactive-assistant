import type { CardSnapshot, RunDetail, TraceArtifact } from "@/api/reward";

export const TRACE_STAGES = ["data-collector", "planner", "card-generator", "evaluator"] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];

const SOURCE_LABELS: Record<string, string> = {
  cards_recent: "近期卡片",
  feedback: "用户反馈",
  gcal: "日历",
  gmail: "邮件",
  goals: "目标",
  memory: "记忆",
  profile: "用户画像",
  signals: "信号",
  world: "外部上下文",
  dreaming: "dreaming 状态",
};

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stagePayload(summary: Record<string, unknown> | null | undefined, stage: string): Record<string, unknown> {
  const stages = summary?.stages;
  if (!stages || typeof stages !== "object") return {};
  const payload = (stages as Record<string, unknown>)[stage];
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

export function stageNodes(summary: Record<string, unknown> | null | undefined, stage: string): number {
  const nodes = stagePayload(summary, stage).nodes;
  return typeof nodes === "number" ? nodes : 0;
}

export function stageSnippets(summary: Record<string, unknown> | null | undefined, stage: string): string[] {
  return stringList(stagePayload(summary, stage).snippets).slice(0, 2);
}

export function clipText(value: string, limit = 220): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}...`;
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ");
  }
}

function quotedValueEnd(value: string, start: number, quote: string, escapedQuote: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    if (escapedQuote) {
      if (value[index] === "\\" && value[index + 1] === quote) {
        const after = value.slice(index + 2, index + 8);
        if (/^\s*[,}\]]/.test(after) || after.length === 0) return index;
      }
      continue;
    }
    if (value[index] === quote && value[index - 1] !== "\\") return index;
  }
  return value.length;
}

function extractReasoningCandidate(value: string): string | null {
  const marker = /\\?["']reasoning\\?["']\s*:\s*\\?(["'])/.exec(value);
  if (!marker || marker.index === undefined) return null;
  const quote = marker[1];
  const markerText = marker[0];
  const escapedQuote = markerText.includes(`\\${quote}`);
  const start = marker.index + markerText.length;
  const end = quotedValueEnd(value, start, quote, escapedQuote);
  const text = decodeJsonString(value.slice(start, end)).trim();
  return text.length > 0 ? text : null;
}

function extractReasoning(value: string): string | null {
  const matches = [...value.matchAll(/"reasoning"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
    .map((match) => decodeJsonString(match[1]))
    .filter((text) => text.trim().length > 0);
  const candidate = extractReasoningCandidate(value);
  if (candidate) matches.push(candidate);
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

export function firstSentences(value: string, limit = 260): string {
  const sentences = value
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？.!?])\s*/)
    .filter(Boolean);
  return clipText(sentences.slice(0, 2).join(" "), limit);
}

function readableTraceLine(value: string): string | null {
  const reasoning = extractReasoning(value);
  if (reasoning) return firstSentences(reasoning, 300);
  if (/ChatLiteLLMReasoning|Middleware\.|openai_api_key|response_metadata|additional_kwargs|generations|outputsPreview|inputsPreview|sandbox files|returned JSON/.test(value)) {
    return null;
  }
  return clipText(value, 260);
}

export function readableTraceLines(values: string[]): string[] {
  return Array.from(new Set(values.map(readableTraceLine).filter((line): line is string => Boolean(line))));
}

export function readableSkippedLines(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => {
    const reasoning = extractReasoning(value);
    if (!reasoning) return null;
    const marker = "规划器的去重说明指出：";
    const markerIndex = reasoning.indexOf(marker);
    if (markerIndex < 0) return null;
    const afterMarker = reasoning.slice(markerIndex + marker.length);
    const [beforeBatch] = afterMarker.split("本批");
    return firstSentences(beforeBatch, 280);
  }).filter((line): line is string => Boolean(line))));
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

function sourceKindFromEvidence(source: string): string {
  const normalized = source.toLowerCase();
  if (normalized.startsWith("cards.recent")) return "cards_recent";
  if (normalized.startsWith("feedback[")) return "feedback";
  if (normalized.startsWith("goal[")) return "goals";
  if (normalized.startsWith("memory[")) return "memory";
  if (normalized.startsWith("signal[")) return "signals";
  if (normalized.startsWith("dreaming[")) return "dreaming";
  if (normalized.includes("gmail")) return "gmail";
  if (normalized.includes("calendar") || normalized.includes("gcal")) return "gcal";
  if (normalized.includes("world")) return "world";
  return "卡片证据";
}

export function sourcePreview(card: CardSnapshot | undefined): string[] {
  return Array.isArray(card?.sources) ? card.sources.filter((source): source is string => typeof source === "string") : [];
}

export function summarizeSources(sources: string[]): string {
  if (sources.length === 0) return "保存下来的卡片证据";
  const labels = sources.map(sourceLabel);
  if (labels.length <= 3) return labels.join("、");
  return `${labels.slice(0, 3).join("、")}等 ${labels.length} 组来源`;
}

export function inferredDataSources(run: RunDetail | null): string[] {
  if (!run) return [];
  return Array.from(new Set(
    run.cards
      .flatMap((entry) => sourcePreview(entry.card))
      .map(sourceKindFromEvidence),
  ));
}

export function cardWhyNow(card: CardSnapshot | undefined): string {
  const value = card?.whyNow ?? card?.why_now;
  return typeof value === "string" && value.trim() ? value : "这张卡没有保存时机说明。";
}

export function cardSummary(card: CardSnapshot | undefined): string {
  const value = card?.summary;
  return typeof value === "string" && value.trim() ? value : "这张卡没有保存摘要。";
}

export function primaryActionLabel(card: CardSnapshot | undefined): string | null {
  const action = card?.primaryAction ?? card?.primary_action;
  if (action && typeof action === "object" && "label" in action) {
    const label = (action as { label?: unknown }).label;
    return typeof label === "string" && label.trim() ? label : null;
  }
  return null;
}

export function traceStatusLabel(status: TraceArtifact["status"] | string | null | undefined): string {
  return {
    failed: "失败",
    missing: "缺失",
    pending: "生成中",
    ready: "已就绪",
  }[status ?? ""] ?? "未知";
}
