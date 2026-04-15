import * as db from '../db.js';
import { CARD_CHAT_INTEREST_ANALYSIS_TYPE } from '../chat-feedback/service.js';

export interface FeedbackActionPattern {
  basket: string;
  count: number;
  intentKeys: string[];
}

export interface RecentFeedbackSummary {
  since: string;
  totalCount: number;
  confirmPatterns: FeedbackActionPattern[];
  modifyPatterns: FeedbackActionPattern[];
  dismissPatterns: FeedbackActionPattern[];
  textPreferences: string[];
  chatInterestPatterns: FeedbackActionPattern[];
  chatTopics: string[];
  chatNextAngles: string[];
}

interface FeedbackRecordLike {
  kind?: string | null;
  action?: string | null;
  basket?: string | null;
  text?: string | null;
  source?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface FeedbackSummaryDeps {
  listFeedback?: (opts?: { since?: string; limit?: number }) => Promise<FeedbackRecordLike[]>;
  feedbackStats?: (opts?: { since?: string }) => Promise<{ total?: number }>;
}

const DEFAULT_LOOKBACK = new Date(Date.now() - 14 * 86400_000).toISOString();
const DEFAULT_LIMIT = 200;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

function buildPatterns(
  records: FeedbackRecordLike[],
  matcher: (record: FeedbackRecordLike) => boolean,
): FeedbackActionPattern[] {
  const groups = new Map<string, { count: number; intentKeys: string[] }>();

  for (const record of records) {
    if (!matcher(record)) continue;
    const basket = asString(record.basket) ?? 'unknown';
    const intentKey = asString(asObject(record.metadata)?.['intentKey']);
    const current = groups.get(basket) ?? { count: 0, intentKeys: [] };
    current.count += 1;
    if (intentKey) current.intentKeys.push(intentKey);
    groups.set(basket, current);
  }

  return [...groups.entries()]
    .map(([basket, value]) => ({
      basket,
      count: value.count,
      intentKeys: unique(value.intentKeys),
    }))
    .sort((left, right) => right.count - left.count || left.basket.localeCompare(right.basket))
    .slice(0, 3);
}

function buildTextPreferences(records: FeedbackRecordLike[]): string[] {
  return records
    .filter((record) => record.kind === 'text_feedback')
    .filter((record) => record.source === 'user_direct' || record.source === 'user_derived')
    .sort((left, right) => (right.created_at ?? '').localeCompare(left.created_at ?? ''))
    .map((record) => asString(record.text))
    .filter((text): text is string => Boolean(text))
    .filter((text, index, items) => items.indexOf(text) === index)
    .slice(0, 3);
}

function isChatInterestRecord(record: FeedbackRecordLike): boolean {
  return record.kind === 'text_feedback'
    && record.source === 'agent_analysis'
    && asObject(record.metadata)?.['analysisType'] === CARD_CHAT_INTEREST_ANALYSIS_TYPE;
}

function buildAgentDerivedList(
  records: FeedbackRecordLike[],
  key: 'topics' | 'nextAngles',
): string[] {
  const values = records
    .filter(isChatInterestRecord)
    .sort((left, right) => (right.created_at ?? '').localeCompare(left.created_at ?? ''))
    .flatMap((record) => {
      const raw = asObject(record.metadata)?.[key];
      return Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
        : [];
    });

  return unique(values).slice(0, 4);
}

export async function loadRecentFeedbackSummary(
  opts?: { since?: string; limit?: number },
  deps?: FeedbackSummaryDeps,
): Promise<RecentFeedbackSummary | null> {
  const listFeedback = deps?.listFeedback ?? ((params?: { since?: string; limit?: number }) => db.listFeedback(params));
  const feedbackStats = deps?.feedbackStats ?? ((params?: { since?: string }) => db.feedbackStats(params));
  const since = opts?.since ?? DEFAULT_LOOKBACK;
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const [rows, stats] = await Promise.all([
    listFeedback({ since, limit }),
    feedbackStats({ since }),
  ]);
  if (rows.length === 0) return null;

  const summary: RecentFeedbackSummary = {
    since,
    totalCount: typeof stats.total === 'number' ? stats.total : rows.length,
    confirmPatterns: buildPatterns(rows, (record) => record.kind === 'card_action' && record.action === 'confirm'),
    modifyPatterns: buildPatterns(rows, (record) => record.kind === 'card_action' && record.action === 'modify'),
    dismissPatterns: buildPatterns(rows, (record) => record.kind === 'dismiss'),
    textPreferences: buildTextPreferences(rows),
    chatInterestPatterns: buildPatterns(rows, isChatInterestRecord),
    chatTopics: buildAgentDerivedList(rows, 'topics'),
    chatNextAngles: buildAgentDerivedList(rows, 'nextAngles'),
  };

  const hasSignals =
    summary.confirmPatterns.length > 0 ||
    summary.modifyPatterns.length > 0 ||
    summary.dismissPatterns.length > 0 ||
    summary.textPreferences.length > 0 ||
    summary.chatInterestPatterns.length > 0 ||
    summary.chatTopics.length > 0 ||
    summary.chatNextAngles.length > 0;

  return hasSignals ? summary : null;
}

function formatPatternLines(label: string, patterns: FeedbackActionPattern[]): string[] {
  return patterns.map((pattern) => {
    const suffix = pattern.intentKeys.length > 0
      ? ` | intent keys: ${pattern.intentKeys.join(', ')}`
      : '';
    return `- ${label}: ${pattern.basket} cards (${pattern.count})${suffix}`;
  });
}

export function formatRecentFeedbackSummary(summary: RecentFeedbackSummary | null): string {
  if (!summary) return '';
  const lines = [
    `Recent feedback window: ${summary.totalCount} events`,
    ...formatPatternLines('Frequently confirmed', summary.confirmPatterns),
    ...formatPatternLines('Frequently modified', summary.modifyPatterns),
    ...formatPatternLines('Frequently dismissed', summary.dismissPatterns),
    ...formatPatternLines('Sustained card chats', summary.chatInterestPatterns),
  ];
  if (summary.textPreferences.length > 0) {
    lines.push(`- Recent text preferences: ${summary.textPreferences.join(' | ')}`);
  }
  if (summary.chatTopics.length > 0) {
    lines.push(`- Chat-derived topics: ${summary.chatTopics.join(' | ')}`);
  }
  if (summary.chatNextAngles.length > 0) {
    lines.push(`- Chat-derived follow-up angles: ${summary.chatNextAngles.join(' | ')}`);
  }
  return lines.join('\n');
}
