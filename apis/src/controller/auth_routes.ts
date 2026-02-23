import { Router, type Application, type Request, type Response } from 'express';
import { renderGatewayTelegramLoginPageHtml, renderSimplePageHtml } from '../domain/auth/pages.js';
import {
  completeGatewayTelegramAuth,
  gatewaySessionCookieOptions,
  startGatewayTelegramAuth
} from '../domain/auth/telegram_login.js';

export const createAuthRouter = (): Router => {
  const router = Router();

  router.get('/auth/telegram/gateway', async (req: Request, res: Response) => {
    const result = await startGatewayTelegramAuth(req);
    if (result.kind === 'error') {
      res.status(200).send(renderSimplePageHtml(result.title, result.message));
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      renderGatewayTelegramLoginPageHtml({
        telegramUserId: result.telegramUserId,
        botUsername: result.botUsername,
        callbackUrl: result.callbackUrl
      })
    );
  });

  router.get('/auth/telegram/callback', async (req: Request, res: Response) => {
    const result = await completeGatewayTelegramAuth(req);
    if (result.kind === 'error') {
      res.status(200).send(renderSimplePageHtml(result.title, result.message));
      return;
    }

    res.cookie(
      'gateway_sid',
      result.sessionToken,
      gatewaySessionCookieOptions(result.telegramUserId, result.expiresAt)
    );
    res.redirect(result.nextPath);
  });

  return router;
};

export const registerAuthRoutes = (app: Application): void => {
  app.use(createAuthRouter());
};
