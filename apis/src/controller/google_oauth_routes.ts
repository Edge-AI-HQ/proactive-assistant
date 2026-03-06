import { Router, type Application, type Request, type Response } from 'express';
import { renderSimplePageHtml } from '../domain/auth/pages.js';
import { renderGoogleCallbackPage, renderGoogleManagePage } from '../domain/google-oauth/pages.js';
import {
  buildGoogleAuthStartUrl,
  disconnectGoogleOAuth,
  getGoogleConnectionStatus,
  handleGoogleOAuthCallback,
  parseTelegramUserId,
  syncCredentialToContainer,
} from '../domain/google-oauth/service.js';

export const createGoogleOAuthRouter = (): Router => {
  const router = Router();

  router.get('/google/manage', async (req: Request, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserId(req.query.telegram_user_id);
      const status = await getGoogleConnectionStatus(telegramUserId);
      res
        .status(200)
        .type('html')
        .send(
          renderGoogleManagePage({
            telegramUserId,
            connected: status.connected,
            statusText: status.connected ? '已连接' : '未连接',
            scopes: status.scopes,
            updatedAt: status.updatedAt,
            email: status.email,
          }),
        );
    } catch (error) {
      res.status(400).send(renderSimplePageHtml('Google Workspace CLI', (error as Error).message));
    }
  });

  router.get('/oauth/google/start', async (req: Request, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserId(req.query.telegram_user_id);
      const nextPath = typeof req.query.next === 'string' ? req.query.next : undefined;
      const url = await buildGoogleAuthStartUrl(telegramUserId, nextPath);
      res.redirect(url);
    } catch (error) {
      res
        .status(400)
        .send(renderSimplePageHtml('Google Workspace CLI Start Failed', (error as Error).message));
    }
  });

  router.get('/oauth/google/callback', async (req: Request, res: Response) => {
    try {
      const result = await handleGoogleOAuthCallback({
        code: typeof req.query.code === 'string' ? req.query.code : undefined,
        state: typeof req.query.state === 'string' ? req.query.state : undefined,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
      });
      res
        .status(200)
        .type('html')
        .send(
          renderGoogleCallbackPage({
            title: 'Google connected',
            message: `${result.message} Telegram user: ${result.telegramUserId}. Returning you to Telegram...`,
            email: result.email,
            botUrl: result.botUsername
              ? `https://t.me/${encodeURIComponent(result.botUsername.replace(/^@/, ''))}?start=google_connected`
              : null,
          }),
        );
    } catch (error) {
      res.status(400).send(renderGoogleCallbackPage({
        title: 'Google connection failed',
        message: (error as Error).message,
      }));
    }
  });

  router.get('/google/api/status', async (req: Request, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserId(req.query.telegram_user_id);
      const status = await getGoogleConnectionStatus(telegramUserId);
      res.status(200).json({ ok: true, ...status });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post('/google/api/disconnect', async (req: Request, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserId(req.body?.telegram_user_id);
      await disconnectGoogleOAuth(telegramUserId);
      res.status(200).json({ ok: true, message: 'Google Workspace credentials disconnected' });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post('/google/api/sync', async (req: Request, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserId(req.body?.telegram_user_id);
      const result = await syncCredentialToContainer(telegramUserId);
      res.status(200).json({ ok: true, message: result.message });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  return router;
};

export const registerGoogleOAuthRoutes = (app: Application): void => {
  app.use(createGoogleOAuthRouter());
};
