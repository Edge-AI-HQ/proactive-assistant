import { Router, type Application, type Request, type Response } from 'express';
import { requireApiAuth } from '../domain/common/httpAuth.js';
import { domainErrorMessage, isDomainError } from '../domain/common/errors.js';
import {
  createAssistantContainerById,
  deleteAssistantContainerById,
  parseAssistantIdParam,
  readContainerRuntime
} from '../domain/container/usecases.js';

export const createContainerRouter = (): Router => {
  const router = Router();

  router.get('/runtime', requireApiAuth, (req: Request, res: Response) => {
    void req;
    res.status(200).json(readContainerRuntime());
  });

  router.post('/assistant/:assistant_id/create', requireApiAuth, async (req: Request<{ assistant_id: string }>, res: Response) => {
    try {
      const assistantId = parseAssistantIdParam(req.params.assistant_id);
      const result = await createAssistantContainerById(assistantId);
      res.status(200).json(result);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: domainErrorMessage(error) });
    }
  });

  router.delete('/assistant/:assistant_id', requireApiAuth, async (req: Request<{ assistant_id: string }>, res: Response) => {
    try {
      const assistantId = parseAssistantIdParam(req.params.assistant_id);
      const result = await deleteAssistantContainerById(assistantId);
      res.status(200).json(result);
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

export const registerContainerRoutes = (app: Application): void => {
  app.use('/api/container', createContainerRouter());
};
