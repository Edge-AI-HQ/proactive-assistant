import { Router, type Application, type Request, type Response } from "express";
import { requireApiAuth } from "../domain/common/httpAuth.js";
import {
  listAssistantsByOwnerId,
  parseAssistantIdParam,
  parseProvisionAssistantInput,
  parseTelegramUserIdParam,
  provisionAssistantByInput,
  createAssistantWithoutContainerByInput,
  readAssistantByIdOrThrow,
  removeAssistantByIdOrThrow,
} from "../domain/claw-assistant/usecases.js";
import { domainErrorMessage, isDomainError } from "../domain/common/errors.js";

export const createClawAssistantRouter = (): Router => {
  const router = Router();

  router.post(
    "/provision",
    requireApiAuth,
    async (req: Request, res: Response) => {
      try {
        const payload = parseProvisionAssistantInput(req.body);
        const result = await provisionAssistantByInput(payload);
        res.status(200).json(result);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/create-without-container",
    requireApiAuth,
    async (req: Request, res: Response) => {
      try {
        const payload = parseProvisionAssistantInput(req.body);
        const result = await createAssistantWithoutContainerByInput(payload);
        res.status(200).json(result);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.get(
    "/owner/:telegram_user_id",
    requireApiAuth,
    async (req: Request<{ telegram_user_id: string }>, res: Response) => {
      try {
        const ownerTelegramUserId = parseTelegramUserIdParam(
          req.params.telegram_user_id,
        );
        const assistants = await listAssistantsByOwnerId(ownerTelegramUserId);
        res.status(200).json({ assistants });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.get(
    "/:assistant_id",
    requireApiAuth,
    async (req: Request<{ assistant_id: string }>, res: Response) => {
      try {
        const assistantId = parseAssistantIdParam(req.params.assistant_id);
        const assistant = await readAssistantByIdOrThrow(assistantId);
        res.status(200).json({ assistant });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.delete(
    "/:assistant_id",
    requireApiAuth,
    async (req: Request<{ assistant_id: string }>, res: Response) => {
      try {
        const assistantId = parseAssistantIdParam(req.params.assistant_id);
        const removed = await removeAssistantByIdOrThrow(assistantId);
        res.status(200).json({ deleted: true, assistant: removed });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  return router;
};

export const registerClawAssistantRoutes = (app: Application): void => {
  app.use("/api/claw-assistant", createClawAssistantRouter());
};
