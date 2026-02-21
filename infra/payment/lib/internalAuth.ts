import type { VercelRequest } from '@vercel/node';

export const verifyInternalApiKey = (req: VercelRequest): { ok: true } | { ok: false; reason: string } => {
  const expected = (process.env.PAYMENT_SERVICE_API_KEY || '').trim();
  if (!expected) {
    return {
      ok: false,
      reason: 'PAYMENT_SERVICE_API_KEY is not configured'
    };
  }

  const provided = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  if (!provided || provided !== expected) {
    return { ok: false, reason: 'Unauthorized' };
  }

  return { ok: true };
};
