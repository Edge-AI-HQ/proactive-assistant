import { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../lib/db.js';

const formatPrice = (priceCents: number): string => (priceCents / 100).toFixed(2);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const plans = await db.listActivePlans();

    const response = plans.map((plan) => {
      const name = plan.display_name.trim() || plan.plan_code;

      return {
        id: plan.plan_code,
        name,
        price: formatPrice(plan.price_cents_monthly),
        priceId: plan.stripe_price_id,
        description: `${name} subscription`,
        features: [
          `${plan.daily_refresh_credits} credits daily refresh (non-cumulative)`,
          `${plan.monthly_refresh_credits} credits monthly refresh (non-cumulative)`,
          '100 credits = $1 usage budget'
        ],
        popular: plan.plan_code === 'pro'
      };
    });

    res.status(200).json({ plans: response });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Get plans error:', error);
    res.status(500).json({ error: message });
  }
}
