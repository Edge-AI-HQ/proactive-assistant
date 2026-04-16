import * as db from '../db.js';

interface GeneratedCardRecord {
  goalBasket?: string | null;
  title?: string | null;
  titleKey?: string | null;
  generatedAt?: string | null;
  threadContext?: {
    threadDecision?: string | null;
    latestCardOutcome?: string | null;
    latestChatSummary?: string | null;
    nextAngles?: string[] | null;
  } | null;
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
      const threadDecision = asString(record.threadContext?.threadDecision) ?? 'hold';
      const latestCardOutcome = asString(record.threadContext?.latestCardOutcome) ?? 'none';
      const latestChatSummary = asString(record.threadContext?.latestChatSummary);
      const nextAngles = Array.isArray(record.threadContext?.nextAngles)
        ? record.threadContext.nextAngles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      const extras = [
        `decision=${threadDecision}`,
        `outcome=${latestCardOutcome}`,
        latestChatSummary ? `chat=${latestChatSummary}` : null,
        nextAngles.length > 0 ? `next=${nextAngles.join('; ')}` : null,
      ].filter((value): value is string => Boolean(value));
      return `- ${basket}: ${titleKey} | ${formatDate(asString(record.generatedAt))} | ${title} | ${extras.join(' | ')}`;
    })
    .join('\n');
}
