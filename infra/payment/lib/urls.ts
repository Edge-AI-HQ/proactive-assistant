import type { VercelRequest } from '@vercel/node';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const readHostBaseUrl = (req: VercelRequest): string => {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  if (!host) {
    throw new Error('Missing request host');
  }
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return `${proto}://${host}`;
};

export const readLandingBaseUrl = (req: VercelRequest): string => {
  const explicit = (process.env.PAYMENT_LANDING_BASE_URL || '').trim();
  if (explicit) {
    return stripTrailingSlash(explicit);
  }
  return stripTrailingSlash(readHostBaseUrl(req));
};
