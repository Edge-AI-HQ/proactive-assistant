import { Router, type Application, type Request, type Response } from 'express';
import { requireApiAuth } from '../domain/common/httpAuth.js';
import { domainErrorMessage, isDomainError } from '../domain/common/errors.js';
import {
  ensureTelegramUserByInput,
  parseEnsureTelegramUserInput,
  parseTelegramUserIdParam,
  readTelegramUserById,
  removeTelegramUserById
} from '../domain/user/usecases.js';

export const createUserRouter = (): Router => {
  const router = Router();

  router.post('/ensure', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const payload = parseEnsureTelegramUserInput(req.body);
      const user = await ensureTelegramUserByInput(payload);
      res.status(200).json({ user });
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.get('/:telegram_user_id', requireApiAuth, async (req: Request<{ telegram_user_id: string }>, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserIdParam(req.params.telegram_user_id);
      const user = await readTelegramUserById(telegramUserId);
      res.status(200).json({ user });
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.delete('/:telegram_user_id', requireApiAuth, async (req: Request<{ telegram_user_id: string }>, res: Response) => {
    try {
      const telegramUserId = parseTelegramUserIdParam(req.params.telegram_user_id);
      const deleted = await removeTelegramUserById(telegramUserId);
      res.status(200).json({ deleted: true, user: deleted });
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  return router;
};

export const registerUserRoutes = (app: Application): void => {
  app.use('/api/user', createUserRouter());
};
