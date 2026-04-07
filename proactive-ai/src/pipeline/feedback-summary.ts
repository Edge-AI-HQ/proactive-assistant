import { runPinCli } from "./pin-cli.js";

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
}

interface FeedbackRecord {
  kind?: string;
  action?: string | null;
  basket?: string | null;
  text?: string | null;
  source?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

const DEFAULT_LOOKBACK = "14d";
const DEFAULT_LIMIT = 200;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

function buildPatterns(
  records: FeedbackRecord[],
  matcher: (record: FeedbackRecord) => boolean,
): FeedbackActionPattern[] {
  const groups = new Map<string, { count: number; intentKeys: string[] }>();

  for (const record of records) {
    if (!matcher(record)) continue;

    const basket = asString(record.basket) ?? "unknown";
    const intentKey = asString(asObject(record.metadata)?.["intentKey"]);
    const current = groups.get(basket) ?? { count: 0, intentKeys: [] };

    current.count += 1;
    if (intentKey) current.intentKeys.push(intentKey);

    groups.set(basket, current);
  }

  return Array.from(groups.entries())
    .map(([basket, value]) => ({
      basket,
      count: value.count,
      intentKeys: unique(value.intentKeys),
    }))
    .sort((left, right) => right.count - left.count || left.basket.localeCompare(right.basket))
    .slice(0, 3);
}

function buildTextPreferences(records: FeedbackRecord[]): string[] {
  return records
    .filter((record) => record.kind === "text_feedback")
    .filter((record) => record.source === "user_direct" || record.source === "user_derived")
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
    .map((record) => asString(record.text))
    .filter((text): text is string => Boolean(text))
    .filter((text, index, items) => items.indexOf(text) === index)
    .slice(0, 3);
}

export async function loadRecentFeedbackSummary(
  options?: { since?: string; limit?: number },
): Promise<RecentFeedbackSummary | null> {
  const since = options?.since ?? DEFAULT_LOOKBACK;
  const limit = options?.limit ?? DEFAULT_LIMIT;

  const [listResult, statsResult] = await Promise.all([
    runPinCli(["feedback", "list", "--since", since, "--limit", String(limit)]),
    runPinCli(["feedback", "stats", "--since", since]),
  ]);

  if (!listResult.ok || !statsResult.ok) {
    return null;
  }

  const records = Array.isArray(listResult.data)
    ? (listResult.data as FeedbackRecord[])
    : [];

  const stats = asObject(statsResult.data);
  const totalCount =
    typeof stats?.["totalCount"] === "number"
      ? stats["totalCount"]
      : records.length;

  const summary: RecentFeedbackSummary = {
    since,
    totalCount,
    confirmPatterns: buildPatterns(
      records,
      (record) => record.kind === "card_action" && record.action === "confirm",
    ),
    modifyPatterns: buildPatterns(
      records,
      (record) => record.kind === "card_action" && record.action === "modify",
    ),
    dismissPatterns: buildPatterns(
      records,
      (record) => record.kind === "dismiss",
    ),
    textPreferences: buildTextPreferences(records),
  };

  const hasSignals =
    summary.confirmPatterns.length > 0 ||
    summary.modifyPatterns.length > 0 ||
    summary.dismissPatterns.length > 0 ||
    summary.textPreferences.length > 0;

  return hasSignals ? summary : null;
}

function formatPatternLines(
  label: string,
  patterns: FeedbackActionPattern[],
): string[] {
  return patterns.map((pattern) => {
    const suffix =
      pattern.intentKeys.length > 0
        ? ` | intent keys: ${pattern.intentKeys.join(", ")}`
        : "";
    return `- ${label}: ${pattern.basket} cards (${pattern.count})${suffix}`;
  });
}

export function formatRecentFeedbackSummary(
  summary: RecentFeedbackSummary | null,
): string {
  if (!summary) return "";

  const lines = [
    `Recent feedback window: last ${summary.since} (${summary.totalCount} feedback events)`,
    ...formatPatternLines("Frequently confirmed", summary.confirmPatterns),
    ...formatPatternLines("Frequently modified", summary.modifyPatterns),
    ...formatPatternLines("Frequently dismissed", summary.dismissPatterns),
  ];

  if (summary.textPreferences.length > 0) {
    lines.push(
      `- Recent text preferences: ${summary.textPreferences.join(" | ")}`,
    );
  }

  return lines.join("\n");
}
