/**
 * On-line metrics — read directly from the v3 storage layer.
 * Used by `pin evals online` (CLI not yet wired) and dashboard endpoints.
 *
 * See evals/README.md.
 */
import * as db from '../db.js';

export interface BasketStats {
  basket: string;
  cardCount: number;
  meanOverall: number;
  passRate: number;
  /** % of cards in this basket that were confirmed by the user */
  confirmRate: number;
  /** % dismissed */
  dismissRate: number;
}

export interface OnlineSnapshot {
  windowSinceIso: string;
  totalEvaluations: number;
  totalFeedback: number;
  byBasket: BasketStats[];
  /** Pearson correlation between self-eval overall and binary user confirm */
  selfEvalConfirmCorrelation: number;
}

/**
 * Compute online metrics from the live DB.
 *
 * The query is intentionally written via the db layer (no raw SQL here) so
 * tests with `withTempHome` can fake the data via the same helpers that
 * production uses.
 */
export async function computeOnlineSnapshot(
  windowSinceIso: string,
): Promise<OnlineSnapshot> {
  // Pull all card_evaluations within the window; this is small (one row
  // per generated card, ~10 cards/run, dozens of runs/day = thousands max).
  // We scan all and filter in JS for simplicity.
  const allEvals = await listEvaluationsSince(windowSinceIso);
  // Pull feedback events similarly.
  const feedback = await db.listFeedback({ since: windowSinceIso, limit: 5000 });

  const confirmsByCard = new Map<string, number>();
  const dismissesByCard = new Map<string, number>();
  for (const f of feedback) {
    if (!f.intent_card_id) continue;
    const action = (f.action ?? '').toLowerCase();
    if (action === 'confirm' || action === 'confirmed') {
      confirmsByCard.set(f.intent_card_id, (confirmsByCard.get(f.intent_card_id) ?? 0) + 1);
    } else if (action === 'dismiss' || action === 'dismissed') {
      dismissesByCard.set(f.intent_card_id, (dismissesByCard.get(f.intent_card_id) ?? 0) + 1);
    }
  }

  const byBasket = new Map<string, {
    cards: number; overallSum: number; passes: number;
    confirms: number; dismisses: number;
  }>();
  for (const e of allEvals) {
    const basket = e.basket ?? 'unknown';
    const stats = byBasket.get(basket) ?? {
      cards: 0, overallSum: 0, passes: 0, confirms: 0, dismisses: 0,
    };
    stats.cards += 1;
    stats.overallSum += e.overall ?? 0;
    if (e.pass) stats.passes += 1;
    if ((confirmsByCard.get(e.card_id) ?? 0) > 0) stats.confirms += 1;
    if ((dismissesByCard.get(e.card_id) ?? 0) > 0) stats.dismisses += 1;
    byBasket.set(basket, stats);
  }

  const selfEvalConfirmCorrelation = pearsonSelfEvalVsConfirm(
    allEvals,
    confirmsByCard,
  );

  return {
    windowSinceIso,
    totalEvaluations: allEvals.length,
    totalFeedback: feedback.length,
    byBasket: Array.from(byBasket.entries()).map(([basket, s]) => ({
      basket,
      cardCount: s.cards,
      meanOverall: s.cards === 0 ? 0 : s.overallSum / s.cards,
      passRate: s.cards === 0 ? 0 : s.passes / s.cards,
      confirmRate: s.cards === 0 ? 0 : s.confirms / s.cards,
      dismissRate: s.cards === 0 ? 0 : s.dismisses / s.cards,
    })),
    selfEvalConfirmCorrelation,
  };
}

/**
 * Substitute for db.listCardEvaluations — that helper is per-run; we want
 * "since". Until db.ts grows a since-filtered helper, scan recent runs.
 */
async function listEvaluationsSince(sinceIso: string): Promise<db.CardEvaluationRow[]> {
  // No global since-filter helper yet — pull recent runs, then collect.
  // Bounded iteration: take the most recent ~100 pipeline runs.
  // (When card_evaluations grows, add a dedicated db helper.)
  const recentRuns = await db.listEvolutionRuns({ limit: 200, since: sinceIso });
  const allEvals: db.CardEvaluationRow[] = [];
  for (const r of recentRuns) {
    const evals = await db.listCardEvaluationsByRun(r.id);
    for (const e of evals) {
      if (e.evaluated_at >= sinceIso) allEvals.push(e);
    }
  }
  return allEvals;
}

function pearsonSelfEvalVsConfirm(
  evals: db.CardEvaluationRow[],
  confirms: Map<string, number>,
): number {
  // Treat "user confirmed at least once" as 1, otherwise 0.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const e of evals) {
    if (e.overall === null || e.overall === undefined) continue;
    xs.push(e.overall);
    ys.push((confirms.get(e.card_id) ?? 0) > 0 ? 1 : 0);
  }
  if (xs.length < 2) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  if (denom === 0) return 0;
  return num / denom;
}
