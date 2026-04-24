/**
 * Pure transformation: agent's per-card score map + final card list
 * → input rows for `db.saveCardEvaluations`.
 *
 * Extracted from orchestrator.ts so the conversion is unit-testable
 * without a live LLM. See docs/plans/memory-architecture.mdx §三 (card_evaluations).
 */

import type { SaveCardEvaluationInput } from '../db.js';

export interface ScoredCardSource {
  /** Final selected card. Used to enrich basket / intentKey on the eval row. */
  id: string;
  goalBasket?: string | null;
  intentKey?: string | null;
}

export interface AgentScore {
  cardId?: string;
  overall?: number;
  pass?: boolean;
  feedback?: string;
  dimensions?: {
    relevance?: number;
    actionability?: number;
    whyNow?: number;
    whyNowClarity?: number;       // alias used by unified-generator agent
    novelty?: number;
    decisionCompression?: number;
  };
}

/**
 * Convert the agent's score map into rows suitable for `saveCardEvaluations`.
 *
 * Filters: only keeps scores whose cardId is present in `finalCards`. Returns
 * an empty array if no scores match — caller should skip the DB write in
 * that case to avoid an unnecessary transaction.
 */
export function extractCardEvaluationsForRun(
  runId: string,
  scoreMap: Record<string, AgentScore | unknown>,
  finalCards: ScoredCardSource[],
): SaveCardEvaluationInput[] {
  if (!runId) return [];
  const finalCardIds = new Set<string>();
  const finalCardLookup = new Map<string, ScoredCardSource>();
  for (const card of finalCards) {
    if (typeof card.id === 'string' && card.id.length > 0) {
      finalCardIds.add(card.id);
      finalCardLookup.set(card.id, card);
    }
  }

  const out: SaveCardEvaluationInput[] = [];
  for (const score of Object.values(scoreMap)) {
    if (!score || typeof score !== 'object') continue;
    const s = score as AgentScore;
    const cardId = typeof s.cardId === 'string' ? s.cardId.trim() : '';
    if (!cardId || !finalCardIds.has(cardId)) continue;

    const card = finalCardLookup.get(cardId);
    const dims = s.dimensions ?? {};
    const overall = typeof s.overall === 'number' ? s.overall : undefined;
    const pass = typeof s.pass === 'boolean' ? s.pass
      : (overall !== undefined ? overall >= 5.0 : true);

    out.push({
      cardId,
      runId,
      intentKey: typeof card?.intentKey === 'string' ? card.intentKey : null,
      basket: typeof card?.goalBasket === 'string' ? card.goalBasket : null,
      dimensions: {
        relevance: typeof dims.relevance === 'number' ? dims.relevance : undefined,
        actionability: typeof dims.actionability === 'number' ? dims.actionability : undefined,
        whyNow: typeof dims.whyNowClarity === 'number' ? dims.whyNowClarity
          : (typeof dims.whyNow === 'number' ? dims.whyNow : undefined),
        novelty: typeof dims.novelty === 'number' ? dims.novelty : undefined,
        decisionCompression: typeof dims.decisionCompression === 'number'
          ? dims.decisionCompression : undefined,
      },
      overall,
      pass,
      evaluator: 'self',
      feedbackText: typeof s.feedback === 'string' ? s.feedback : null,
    });
  }
  return out;
}
