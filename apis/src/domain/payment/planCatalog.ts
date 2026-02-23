import { config } from '../common/config.js';

export type PlanCode = 'basic' | 'pro' | 'max';

const planPriceIdMap: Record<PlanCode, string> = {
  basic: config.payment.stripePriceIdBasic,
  pro: config.payment.stripePriceIdPro,
  max: config.payment.stripePriceIdMax
};

export const normalizePlanCode = (value: unknown): PlanCode | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'basic' || normalized === 'pro' || normalized === 'max') {
    return normalized;
  }
  return null;
};

export const getStripePriceIdForPlanCode = (planCodeRaw: unknown): string | null => {
  const planCode = normalizePlanCode(planCodeRaw);
  if (!planCode) return null;
  const priceId = planPriceIdMap[planCode].trim();
  return priceId || null;
};

export const resolvePlanCodeFromStripePriceId = (priceIdRaw: unknown): PlanCode | null => {
  if (typeof priceIdRaw !== 'string') return null;
  const priceId = priceIdRaw.trim();
  if (!priceId) return null;

  for (const [planCode, configuredPriceId] of Object.entries(planPriceIdMap) as Array<[PlanCode, string]>) {
    if (configuredPriceId.trim() === priceId) {
      return planCode;
    }
  }

  return null;
};
