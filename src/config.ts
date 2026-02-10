import 'dotenv/config';
import path from 'node:path';
import type { Config, RequiredSecret } from './types.js';

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const toCsvList = (value: string | undefined): string[] =>
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

const port = toInt(process.env.PORT, 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const wsPathRaw = process.env.OPENCLAW_WS_PATH;

export const config: Config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  publicBaseUrl,
  apiDomain: process.env.API_DOMAIN || 'api.pinai.io',
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite'),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || `${publicBaseUrl}/auth/google/callback`
  },
  auth: {
    allowedDomains: toCsvList(process.env.AUTH_ALLOWED_DOMAINS || 'pinai.io'),
    allowedEmails: toCsvList(process.env.AUTH_ALLOWED_EMAILS || '')
  },
  openclaw: {
    image: process.env.OPENCLAW_IMAGE || 'pinai-openclaw:latest',
    gatewayPort: toInt(process.env.OPENCLAW_GATEWAY_PORT, 18789),
    httpPath: ensureLeadingSlash(process.env.OPENCLAW_HTTP_PATH || '/v1/chat/completions'),
    wsPath: wsPathRaw === '/' ? '/' : ensureLeadingSlash(wsPathRaw || '/'),
    apiKey: process.env.OPENCLAW_API_KEY || '',
    braveApiKey: process.env.BRAVE_API_KEY || ''
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '',
    baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io',
    sttModel: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1'
  },
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET || '',
    sessionTtlHours: toInt(process.env.ADMIN_SESSION_TTL_HOURS, 12)
  },
  container: {
    portStart: toInt(process.env.CONTAINER_PORT_START, 20000),
    portEnd: toInt(process.env.CONTAINER_PORT_END, 22000),
    memoryMb: toInt(process.env.CONTAINER_MEMORY_MB, 2048),
    cpuShares: toInt(process.env.CONTAINER_CPU_SHARES, 512)
  },
  featureFlags: {
    allowMissingSecrets: toBool(process.env.ALLOW_MISSING_SECRETS, false)
  }
};

export const requiredSecrets: RequiredSecret[] = [
  ['TELEGRAM_BOT_TOKEN', config.telegram.token],
  ['GOOGLE_CLIENT_ID', config.google.clientId],
  ['GOOGLE_CLIENT_SECRET', config.google.clientSecret]
];

export const validateConfig = (): string[] => {
  const missing = requiredSecrets.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length && config.nodeEnv === 'production' && !config.featureFlags.allowMissingSecrets) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  return missing;
};
