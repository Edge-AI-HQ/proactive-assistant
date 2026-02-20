import type { VercelRequest, VercelResponse } from '@vercel/node';
import { paymentBackendClient } from '../lib/paymentBackendClient.js';

type CheckoutBody = {
  token?: string;
  plan?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = (req.body || {}) as CheckoutBody;
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const plan = typeof body.plan === 'string' && body.plan.trim() ? body.plan.trim() : 'basic';

  if (!token) {
    res.status(400).json({ error: 'Token is required' });
    return;
  }

  try {
    const result = await paymentBackendClient.createCheckout(token, plan);
    res.status(200).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: message });
  }
}
