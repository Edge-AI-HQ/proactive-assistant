import type { VercelRequest, VercelResponse } from '@vercel/node';
import { paymentBackendClient } from '../lib/paymentBackendClient.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const result = await paymentBackendClient.getPlans();
    res.status(200).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: message });
  }
}
