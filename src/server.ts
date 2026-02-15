import express, { type Request, type Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { config, validateConfig } from './config.js';
import { registerAuthRoutes } from './auth/google.js';
import { registerAdminRoutes } from './admin/routes.js';
import { cleanupExpiredOauthSessions, purgeExpiredAdminSessions } from './db.js';
import { sanitizeAllCronStores } from './docker/manager.js';
import { buildBot } from './telegram/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const toSingleHeader = (value: string | string[] | undefined): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const missing = validateConfig();
if (missing.length) {
  console.warn(`Missing env vars: ${missing.join(', ')}`);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'src', 'views'));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

const bot = buildBot();
await bot.init();

sanitizeAllCronStores();

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

registerAuthRoutes(app, bot);
registerAdminRoutes(app);

app.get('/health', (req: Request, res: Response) => {
  void req;
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/', (req: Request, res: Response) => {
  void req;
  res.send('PIN AI Assistant backend is running.');
});

setInterval(() => {
  cleanupExpiredOauthSessions();
  purgeExpiredAdminSessions();
}, 5 * 60 * 1000);

const server = http.createServer(app);
server.listen(config.port, () => {
  console.log(`PIN AI Assistant listening on :${config.port}`);
});
