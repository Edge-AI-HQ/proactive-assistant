/**
 * 套餐代码类型与标准化。
 * Stripe price ID 现从 billing_plans.stripe_price_id 读取，不再依赖环境变量。
 */

export type PlanCode = 'basic' | 'pro' | 'max';

export const normalizePlanCode = (value: unknown): PlanCode | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'basic' || normalized === 'pro' || normalized === 'max') {
    return normalized;
  }
  return null;
};
