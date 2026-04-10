import type { PlannerOutput } from "../../core/index.js";
import type { ContextBrief } from "./context-builder.js";
import type { TraceEventRecord } from "./trace.js";

export interface IntentEvidenceFact {
  ref: string;
  value: unknown;
}

export interface IntentEvidencePack {
  intentIndex: number;
  goalBasket: string;
  objective: string;
  whyNow: string;
  expectedAction: string;
  evidenceRefs: string[];
  contextGaps: string[];
  facts: IntentEvidenceFact[];
}

export interface BuildIntentEvidencePacksInput {
  contextBrief: ContextBrief;
  plan: PlannerOutput;
  onTrace?: (event: TraceEventRecord) => void;
}

type Resolver = (brief: ContextBrief) => unknown[];

const RESOLVERS: Record<string, Resolver> = {
  "profile.profile": (brief) => brief.dedupContext.profile ? [brief.dedupContext.profile.profile] : [],
  "profile.facts": (brief) => brief.dedupContext.profile ? [brief.dedupContext.profile.facts] : [],
  "profile.goals": (brief) => brief.dedupContext.profile ? [brief.dedupContext.profile.goals] : [],
  "profile.preferences": (brief) => brief.dedupContext.profile ? [brief.dedupContext.profile.preferences] : [],
  "profile.constraints": (brief) => brief.dedupContext.profile ? [brief.dedupContext.profile.constraints] : [],
  "profile.snapshot": (brief) => brief.dedupContext.profile?.snapshot ? [brief.dedupContext.profile.snapshot] : [],
  "personal.status": (brief) => [brief.dedupContext.personal.status],
  "personal.connections": (brief) => [brief.dedupContext.personal.connections],
  "recent.push": (brief) => brief.dedupContext.recentSignals.pushes,
  "recent.feedback": (brief) => brief.dedupContext.recentSignals.feedback,
  "world.shortlist": (brief) => brief.dedupContext.world.shortlist,
  "incremental.world": (brief) => brief.dedupContext.recentSignals.incremental.world,
  "incremental.personal": (brief) => brief.dedupContext.recentSignals.incremental.personal,
};

function nowIso(): string {
  return new Date().toISOString();
}

function dedupeRefs(refs: string[] | undefined): string[] {
  return [...new Set((refs ?? []).filter(Boolean))];
}

function resolveFacts(brief: ContextBrief, refs: string[]): IntentEvidenceFact[] {
  const facts: IntentEvidenceFact[] = [];
  for (const ref of refs) {
    const resolver = RESOLVERS[ref];
    const values = resolver ? resolver(brief) : [];
    for (const value of values) {
      facts.push({ ref, value });
    }
  }
  return facts;
}

export async function buildIntentEvidencePacks(
  input: BuildIntentEvidencePacksInput,
): Promise<IntentEvidencePack[]> {
  const emit = input.onTrace ?? (() => {});
  const cache = new Map<string, IntentEvidenceFact[]>();

  return input.plan.intentsToGenerate.map((intent, index) => {
    emit({
      timestamp: nowIso(),
      phase: "evidence",
      kind: "evidence.pack.start",
      name: intent.objective,
      iteration: undefined,
    });

    const evidenceRefs = dedupeRefs(intent.evidenceRefs ?? intent.dataSources);
    const facts: IntentEvidenceFact[] = [];
    for (const ref of evidenceRefs) {
      if (!cache.has(ref)) {
        cache.set(ref, resolveFacts(input.contextBrief, [ref]));
      }
      facts.push(...(cache.get(ref) ?? []));
    }

    const pack: IntentEvidencePack = {
      intentIndex: index,
      goalBasket: intent.goalBasket,
      objective: intent.objective,
      whyNow: intent.whyNow,
      expectedAction: intent.expectedAction,
      evidenceRefs,
      contextGaps: intent.contextGaps ?? input.plan.contextGaps ?? [],
      facts,
    };

    emit({
      timestamp: nowIso(),
      phase: "evidence",
      kind: "evidence.pack.finish",
      name: intent.objective,
      attrs: {
        evidenceRefs,
        factCount: facts.length,
      },
    });

    return pack;
  });
}
