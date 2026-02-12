import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    status: 'ok',
    message: 'OpenClaw Cloud API is running',
    timestamp: new Date().toISOString(),
    env_check: {
      stripe_key: process.env.STRIPE_SECRET_KEY ? '✓ Set' : '✗ Missing',
      supabase_url: process.env.SUPABASE_URL ? '✓ Set' : '✗ Missing',
      price_id: process.env.STRIPE_PRICE_ID ? '✓ Set' : '✗ Missing',
    }
  });
}
