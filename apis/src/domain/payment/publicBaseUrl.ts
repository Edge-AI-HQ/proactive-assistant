import type { Request } from 'express';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const firstHeaderValue = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
};

const readForwardedProto = (req: Request): string => {
  const raw = firstHeaderValue(req.headers['x-forwarded-proto']).trim().toLowerCase();
  if (!raw) return '';
  const first = raw.split(',')[0]?.trim() || '';
  if (first === 'http' || first === 'https') return first;
  return '';
};

const readHost = (req: Request): string => {
  const forwarded = firstHeaderValue(req.headers['x-forwarded-host'] as string | string[] | undefined).trim();
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim() || '';
    if (first) return first;
  }

  const host = firstHeaderValue(req.headers.host as string | string[] | undefined).trim();
  if (!host) {
    throw new Error('Missing request host');
  }
  return host;
};

const inferProtoFromHost = (host: string): 'http' | 'https' => {
  const hostname = host.split(':')[0]?.toLowerCase() || '';
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  ) {
    return 'http';
  }
  return 'https';
};

export const readRequestBaseUrl = (req: Request): string => {
  const host = readHost(req);
  const proto = readForwardedProto(req) || inferProtoFromHost(host);
  return `${proto}://${host}`;
};

export const readPaymentPublicBaseUrl = (req?: Request): string => {
  const explicit = (process.env.PAYMENT_PUBLIC_BASE_URL || '').trim();

  if (explicit) {
    return stripTrailingSlash(explicit);
  }

  if (!req) {
    throw new Error('PAYMENT_PUBLIC_BASE_URL is required when request context is unavailable');
  }

  return stripTrailingSlash(readRequestBaseUrl(req));
};
