import type { VercelRequest, VercelResponse } from '@vercel/node';
import { paymentBackendClient } from '../lib/paymentBackendClient.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  let backendStatus: 'ok' | 'unreachable' = 'ok';
  let backendError: string | null = null;

  try {
    await paymentBackendClient.health();
  } catch (error: unknown) {
    backendStatus = 'unreachable';
    backendError = error instanceof Error ? error.message : 'Unknown error';
  }

  res.status(200).json({
    status: 'ok',
    service: 'payment-gateway-app',
    message: 'Landing app + test bot layer',
    timestamp: new Date().toISOString(),
    env_check: {
      telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN ? '✓ Set' : '✗ Missing',
      payment_backend_base_url: process.env.PAYMENT_BACKEND_BASE_URL ? '✓ Set' : '✗ Missing',
      payment_backend_api_key:
        process.env.PAYMENT_BACKEND_API_KEY || process.env.PINCLAW_INTERNAL_API_KEY ? '✓ Set' : '✗ Missing'
    },
    upstream: {
      payment_backend: backendStatus,
      error: backendError
    }
  });
}
