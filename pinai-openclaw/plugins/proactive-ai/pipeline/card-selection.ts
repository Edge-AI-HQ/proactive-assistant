/**
 * Card selection logic — picks the best cards from the evaluation pool.
 */

const MAX_FINAL_CARDS = 10;
const MAX_PER_BASKET = 3;
const PASS_THRESHOLD = 5.0;

export interface ScoredCard {
  card: Record<string, unknown>;
  score: { overall: number; pass: boolean; cardId: string };
}

export function selectBestCards(pool: ScoredCard[]): Array<Record<string, unknown>> {
  if (pool.length === 0) return [];
  const sorted = [...pool].sort((a, b) => b.score.overall - a.score.overall);
  let selected = pickWithDiversity(sorted.filter(c => c.score.pass && c.score.overall >= PASS_THRESHOLD));
  if (selected.length === 0) selected = pickWithDiversity(sorted);
  return selected;
}

function pickWithDiversity(candidates: ScoredCard[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const basketCount = new Map<string, number>();
  for (const { card } of candidates) {
    if (result.length >= MAX_FINAL_CARDS) break;
    const basket = String(card['goalBasket'] ?? 'unknown');
    const count = basketCount.get(basket) ?? 0;
    if (count >= MAX_PER_BASKET) continue;
    result.push(card);
    basketCount.set(basket, count + 1);
  }
  return result;
}

export function syntheticScore(cardId: string): { cardId: string; overall: number; pass: boolean; dimensions: Record<string, number>; feedback: string } {
  return {
    cardId, overall: 7.0, pass: true,
    dimensions: { relevance: 7, actionability: 7, whyNowClarity: 7, novelty: 7, decisionCompression: 7 },
    feedback: 'No evaluation available — using default score',
  };
}
