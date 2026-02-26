import { config } from '../common/config.js';
import { db } from './db.js';
import type { PlanCode } from './planCatalog.js';
import { requireStripe } from './stripeClient.js';

const orderedPlanCodes: PlanCode[] = ['basic', 'pro', 'max'];

export const validatePaymentPriceConsistencyOnStartup = async (): Promise<void> => {
  const stripe = requireStripe();
  const plans = await db.listActivePlans();
  const planMap = new Map(plans.map((plan) => [plan.plan_code, plan]));
  const issues: string[] = [];

  for (const planCode of orderedPlanCodes) {
    const dbPlan = planMap.get(planCode);
    if (!dbPlan) {
      issues.push(`Missing active DB billing plan row for plan ${planCode}`);
      continue;
    }
    const configuredPriceId = (dbPlan.stripe_price_id || '').trim();
    if (!configuredPriceId) {
      issues.push(`Missing stripe_price_id for plan ${planCode} (set in billing_plans or run scripts/create-stripe-prices.mjs)`);
      continue;
    }

    try {
      const stripePrice = await stripe.prices.retrieve(configuredPriceId);
      const unitAmount = typeof stripePrice.unit_amount === 'number' ? stripePrice.unit_amount : null;
      if (unitAmount === null) {
        issues.push(`Stripe price ${configuredPriceId} for ${planCode} is missing unit_amount`);
      } else if (unitAmount !== dbPlan.price_cents_monthly) {
        issues.push(
          `Plan ${planCode} amount mismatch: DB=${dbPlan.price_cents_monthly}c Stripe=${unitAmount}c (price_id=${configuredPriceId})`
        );
      }

      const stripeCurrency = (stripePrice.currency || '').toLowerCase();
      const dbCurrency = (dbPlan.currency || '').toLowerCase();
      if (stripeCurrency && dbCurrency && stripeCurrency !== dbCurrency) {
        issues.push(`Plan ${planCode} currency mismatch: DB=${dbCurrency} Stripe=${stripeCurrency} (price_id=${configuredPriceId})`);
      }

      if (!stripePrice.active) {
        issues.push(`Stripe price ${configuredPriceId} for ${planCode} is inactive`);
      }

      if (stripePrice.type !== 'recurring') {
        issues.push(`Stripe price ${configuredPriceId} for ${planCode} must be recurring`);
      } else {
        const interval = stripePrice.recurring?.interval;
        if (interval && interval !== 'month') {
          issues.push(`Stripe price ${configuredPriceId} for ${planCode} must be monthly (found ${interval})`);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      issues.push(`Failed to retrieve Stripe price ${configuredPriceId} for ${planCode}: ${message}`);
    }
  }

  if (issues.length) {
    const message = `Payment price consistency validation failed:\n- ${issues.join('\n- ')}`;
    if (config.nodeEnv === 'production') {
      throw new Error(message);
    }
    console.warn(message);
  }
};
