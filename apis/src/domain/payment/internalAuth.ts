import type { Request } from 'express';

export const verifyInternalApiKey = (req: Request): { ok: true } | { ok: false; reason: string } => {
  const expected = (process.env.API_INTERNAL_TOKEN || '').trim();

  if (!expected) {
    return {
      ok: false,
      reason: 'API_INTERNAL_TOKEN is not configured'
    };
  }

  const providedHeader = req.headers['x-api-key'];
  const provided = typeof providedHeader === 'string' ? providedHeader.trim() : Array.isArray(providedHeader) ? (providedHeader[0] || '').trim() : '';
  if (!provided || provided !== expected) {
    return { ok: false, reason: 'Unauthorized' };
  }

  return { ok: true };
};
