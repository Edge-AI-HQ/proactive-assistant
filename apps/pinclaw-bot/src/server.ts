import express, { type Request, type Response } from 'express';
import { config, validateConfig } from './config.js';
import { buildBot } from './telegram/bot.js';

type TelegramUpdateMode = 'auto' | 'webhook' | 'polling';

const toSingleHeader = (value: string | string[] | undefined): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const normalizeUpdateMode = (value: string | undefined): TelegramUpdateMode => {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'webhook') return 'webhook';
  if (normalized === 'polling') return 'polling';
  return 'auto';
};

const isLocalhostHost = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  );
};

const toPublicOrigin = (raw: string | undefined): URL | null => {
  if (!raw?.trim()) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || isLocalhostHost(parsed.hostname)) {
      return null;
    }
    return new URL(parsed.origin);
  } catch {
    return null;
  }
};

const buildWebhookUrl = (origin: URL): string => new URL('/webhook/telegram', origin).toString();

const resolveWebhookUrl = (): string | null => {
  const explicitWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (explicitWebhookUrl) {
    try {
      const parsed = new URL(explicitWebhookUrl);
      if (parsed.protocol === 'https:' && !isLocalhostHost(parsed.hostname)) {
        return parsed.toString();
      }
      console.warn(`Ignoring TELEGRAM_WEBHOOK_URL because it is not a public HTTPS URL: ${explicitWebhookUrl}`);
    } catch {
      console.warn(`Ignoring invalid TELEGRAM_WEBHOOK_URL: ${explicitWebhookUrl}`);
    }
  }

  const configuredOrigin = toPublicOrigin(config.publicBaseUrl);
  if (configuredOrigin) {
    return buildWebhookUrl(configuredOrigin);
  }

  return null;
};

const missing = validateConfig();
if (missing.length) {
  console.warn(`Missing env vars: ${missing.join(', ')}`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json());

const bot = buildBot();
await bot.init();

const startPollingMode = async (): Promise<void> => {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (error: unknown) {
    console.warn('Failed to clear webhook before polling; continuing anyway', error);
  }

  void bot.start({ drop_pending_updates: false }).catch((error: unknown) => {
    console.error('Telegram polling crashed', error);
  });
  console.log('Telegram updates mode: polling');
};

const startWebhookMode = async (url: string): Promise<void> => {
  const options: { drop_pending_updates: false; secret_token?: string } = {
    drop_pending_updates: false
  };
  if (config.telegram.webhookSecret) {
    options.secret_token = config.telegram.webhookSecret;
  }

  await bot.api.setWebhook(url, options);
  console.log(`Telegram updates mode: webhook (${url})`);
};

const configureTelegramUpdates = async (): Promise<void> => {
  const mode = normalizeUpdateMode(process.env.TELEGRAM_UPDATE_MODE);

  if (mode === 'polling') {
    await startPollingMode();
    return;
  }

  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl && mode === 'webhook') {
    throw new Error('TELEGRAM_UPDATE_MODE=webhook requires TELEGRAM_WEBHOOK_URL or PUBLIC_BASE_URL (public HTTPS).');
  }

  if (webhookUrl) {
    try {
      await startWebhookMode(webhookUrl);
      return;
    } catch (error: unknown) {
      console.error('Failed to enable Telegram webhook mode', error);
      if (mode === 'webhook') {
        throw error;
      }
    }
  } else {
    console.warn('No usable public HTTPS webhook URL detected. Falling back to polling.');
  }

  await startPollingMode();
};

app.post('/webhook/telegram', async (req: Request, res: Response) => {
  try {
    if (config.telegram.webhookSecret) {
      const secretHeader = toSingleHeader(req.headers['x-telegram-bot-api-secret-token']);
      if (secretHeader !== config.telegram.webhookSecret) {
        res.sendStatus(403);
        return;
      }
    }

    res.sendStatus(200);
    void bot.handleUpdate(req.body).catch((error: unknown) => {
      console.error('Telegram webhook async handling error', error);
    });
  } catch (error: unknown) {
    console.error('Telegram webhook error', error);
    res.sendStatus(500);
  }
});

app.get('/health', (req: Request, res: Response) => {
  void req;
  res.json({ ok: true, service: 'pinclaw-bot-frontend', time: new Date().toISOString() });
});

app.get('/', (req: Request, res: Response) => {
  void req;
  res.send('PIN Claw Bot frontend is running.');
});

app.listen(config.port, () => {
  console.log(`PIN Claw Bot frontend listening on :${config.port}`);
  void configureTelegramUpdates().catch((error: unknown) => {
    console.error('Failed to configure Telegram update mode', error);
    process.exit(1);
  });
});
