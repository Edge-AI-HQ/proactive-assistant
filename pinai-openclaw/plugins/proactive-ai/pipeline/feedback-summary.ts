/**
 * Feedback summary for pipeline context — loads recent feedback
 * and formats it for the Planner/Generator agents.
 */
import * as db from '../db.js';

export interface RecentFeedbackSummary {
  since: string;
  totalCount: number;
  confirmPatterns: Array<{ basket: string; count: number }>;
  dismissPatterns: Array<{ basket: string; count: number }>;
  textPreferences: string[];
}

export async function loadRecentFeedbackSummary(opts?: { since?: string }): Promise<RecentFeedbackSummary | null> {
  const since = opts?.since ?? new Date(Date.now() - 14 * 86400_000).toISOString();
  const rows = await db.listFeedback({ since, limit: 200 });
  if (rows.length === 0) return null;

  const confirms = new Map<string, number>();
  const dismisses = new Map<string, number>();
  const texts: string[] = [];

  for (const row of rows) {
    const basket = row.basket ?? 'unknown';
    if (row.kind === 'card_action' && row.action === 'confirm') {
      confirms.set(basket, (confirms.get(basket) ?? 0) + 1);
    }
    if (row.kind === 'dismiss') {
      dismisses.set(basket, (dismisses.get(basket) ?? 0) + 1);
    }
    if (row.kind === 'text_feedback' && row.text && (row.source === 'user_direct' || row.source === 'user_derived')) {
      texts.push(row.text);
    }
  }

  const toPatterns = (m: Map<string, number>) =>
    [...m.entries()].map(([basket, count]) => ({ basket, count })).sort((a, b) => b.count - a.count).slice(0, 3);

  const summary: RecentFeedbackSummary = {
    since, totalCount: rows.length,
    confirmPatterns: toPatterns(confirms),
    dismissPatterns: toPatterns(dismisses),
    textPreferences: [...new Set(texts)].slice(0, 3),
  };

  return (summary.confirmPatterns.length > 0 || summary.dismissPatterns.length > 0 || summary.textPreferences.length > 0)
    ? summary : null;
}

export function formatRecentFeedbackSummary(summary: RecentFeedbackSummary | null): string {
  if (!summary) return '';
  const lines = [`Recent feedback window: ${summary.totalCount} events`];
  for (const p of summary.confirmPatterns) lines.push(`- Frequently confirmed: ${p.basket} cards (${p.count})`);
  for (const p of summary.dismissPatterns) lines.push(`- Frequently dismissed: ${p.basket} cards (${p.count})`);
  if (summary.textPreferences.length > 0) lines.push(`- Recent text preferences: ${summary.textPreferences.join(' | ')}`);
  return lines.join('\n');
}
