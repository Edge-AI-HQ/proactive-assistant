import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 获取价格信息
    const [basicPrice, proPrice, maxPrice] = await Promise.all([
      stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_BASIC!),
      stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_PRO!),
      stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_MAX!),
    ]);

    const plans = [
      {
        id: 'basic',
        name: 'Basic',
        price: (basicPrice.unit_amount! / 100).toFixed(2),
        priceId: basicPrice.id,
        description: 'For individual developers',
        features: [
          '2GB RAM',
          'Dedicated container',
          '24/7 uptime',
          'Auto backup',
          'Email support',
        ],
        popular: false,
      },
      {
        id: 'pro',
        name: 'Pro',
        price: (proPrice.unit_amount! / 100).toFixed(2),
        priceId: proPrice.id,
        description: 'For small teams',
        features: [
          '4GB RAM',
          'Dedicated container',
          '24/7 uptime',
          'Auto backup',
          'Priority support',
          'Performance monitoring',
        ],
        popular: true,
      },
      {
        id: 'max',
        name: 'Max',
        price: (maxPrice.unit_amount! / 100).toFixed(2),
        priceId: maxPrice.id,
        description: 'For enterprises',
        features: [
          '8GB RAM',
          'Dedicated resources',
          '24/7 uptime',
          'Auto backup',
          '24/7 premium support',
          'Performance monitoring',
          'SLA guarantee',
        ],
        popular: false,
      },
    ];

    res.status(200).json({ plans });
  } catch (error: any) {
    console.error('Get plans error:', error);
    res.status(500).json({ error: error.message });
  }
}
