import { Router, type Application, type Request, type Response } from 'express';
import { requireApiAuth } from '../domain/common/httpAuth.js';
import { domainErrorMessage, isDomainError } from '../domain/common/errors.js';
import {
  handleLiteLLMBudgetAlert,
  readBudgetByTelegramUserId,
  readCreditStatusByTelegramUserId,
  refreshDailyCredits,
  refreshMonthlyCredits,
  updateBudgetByTelegramUserId
} from '../domain/meter/usecases.js';

export const createMeterRouter = (): Router => {
  const router = Router();

  router.get('/budget/:telegram_user_id', requireApiAuth, async (req: Request<{ telegram_user_id: string }>, res: Response) => {
    try {
      const response = await readBudgetByTelegramUserId(req.params.telegram_user_id);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.post('/budget/:telegram_user_id', requireApiAuth, async (req: Request<{ telegram_user_id: string }>, res: Response) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const response = await updateBudgetByTelegramUserId(req.params.telegram_user_id, body);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.get('/credit-status/:telegram_user_id', requireApiAuth, async (req: Request<{ telegram_user_id: string }>, res: Response) => {
    try {
      const response = await readCreditStatusByTelegramUserId(req.params.telegram_user_id);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.post('/refresh/daily', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const response = await refreshDailyCredits(body);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.post('/refresh/monthly', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const response = await refreshMonthlyCredits(body);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.post('/webhook/litellm-budget-alert', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const response = await handleLiteLLMBudgetAlert(body);
      res.status(200).json(response);
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

export const registerMeterRoutes = (app: Application): void => {
  app.use('/api/meter', createMeterRouter());
};
