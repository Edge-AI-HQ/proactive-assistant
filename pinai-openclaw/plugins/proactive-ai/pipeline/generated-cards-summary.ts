import * as db from '../db.js';

interface GeneratedCardRecord {
  goalBasket?: string | null;
  title?: string | null;
  titleKey?: string | null;
  generatedAt?: string | null;
}

interface GeneratedCardsSummaryDeps {
  listRecentGeneratedCards?: (opts?: { limit?: number; since?: string }) => Promise<GeneratedCardRecord[]>;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

function formatDate(iso: string | null): string {
  if (!iso) return 'unknown-date';
  return iso.slice(0, 10);
}

export async function loadRecentGeneratedCardsSummary(
  options?: { limit?: number; since?: string },
  deps?: GeneratedCardsSummaryDeps,
): Promise<string> {
  const listRecentGeneratedCards = deps?.listRecentGeneratedCards
    ?? ((opts?: { limit?: number; since?: string }) => db.listRecentGeneratedCards(opts));

  const records = await listRecentGeneratedCards({
    limit: options?.limit ?? 10,
    since: options?.since,
  });
  if (records.length === 0) return '';

  return records
    .map((record) => {
      const basket = asString(record.goalBasket) ?? 'unknown';
      const titleKey = asString(record.titleKey) ?? 'unknown';
      const title = asString(record.title) ?? 'Untitled card';
      return `- ${basket}: ${titleKey} | ${formatDate(asString(record.generatedAt))} | ${title}`;
    })
    .join('\n');
}
