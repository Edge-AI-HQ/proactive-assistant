const ACTIVE_STATUSES = ["active", "trialing", "past_due"] as const;

export type SubscriptionSnapshot =
  | {
      plan_id?: string | null;
      status?: string | null;
      cancel_at_period_end?: boolean | null;
      current_period_end?: string | null;
    }
  | null
  | undefined;

export const isSubscriptionActiveForService = (
  current: SubscriptionSnapshot,
  now: Date = new Date(),
): boolean => {
  if (!current?.plan_id) return false;

  const status = String(current.status || "") as (typeof ACTIVE_STATUSES)[number];
  if (!ACTIVE_STATUSES.includes(status)) return false;

  if (current.cancel_at_period_end && current.current_period_end) {
    const periodEnd = new Date(current.current_period_end);
    if (!Number.isFinite(periodEnd.getTime())) return false;
    if (periodEnd <= now) return false;
  }

  return true;
};
