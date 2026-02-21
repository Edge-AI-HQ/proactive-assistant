import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    status: 'ok',
    service: 'infra-payment',
    message: 'Infra payment backend is running',
    timestamp: new Date().toISOString(),
    env_check: {
      stripe_key: process.env.STRIPE_SECRET_KEY ? '✓ Set' : '✗ Missing',
      supabase_db_url: process.env.SUPABASE_DB_URL ? '✓ Set' : '✗ Missing',
      payment_service_api_key: process.env.PAYMENT_SERVICE_API_KEY ? '✓ Set' : '✗ Missing',
      payment_public_base_url: process.env.PAYMENT_PUBLIC_BASE_URL ? '✓ Set' : '○ Optional',
      litellm_base_url: process.env.LITELLM_BASE_URL ? '✓ Set' : '○ Optional',
      litellm_master_key: process.env.LITELLM_MASTER_KEY ? '✓ Set' : '○ Optional'
    }
  });
}
