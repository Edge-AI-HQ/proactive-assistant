import { Router, type Application, type Request, type Response } from "express";
import { renderSimplePageHtml } from "../domain/auth/pages.js";
import { renderGoogleCallbackPage } from "../domain/google-oauth/pages.js";

export const createGoogleOAuthRouter = (): Router => {
  const router = Router();

  router.get("/google/manage", (_req: Request, res: Response) => {
    res
      .status(410)
      .type("html")
      .send(
        renderSimplePageHtml(
          "Google management moved",
          "Google connection is now managed inside the PIN AI mini app. Open the mini app and use Manage > Connect Google.",
        ),
      );
  });

  router.get("/oauth/google/start", (_req: Request, res: Response) => {
    res
      .status(410)
      .type("html")
      .send(
        renderSimplePageHtml(
          "Google start moved",
          "Start Google authorization from the PIN AI mini app.",
        ),
      );
  });

  router.get("/oauth/google/callback", (_req: Request, res: Response) => {
    res
      .status(410)
      .type("html")
      .send(
        renderGoogleCallbackPage({
          title: "Google connection moved",
          message:
            "This callback is no longer used. Use the PIN AI mini app flow at /mini/google/start and /mini/google/callback.",
        }),
      );
  });

  return router;
};

export const registerGoogleOAuthRoutes = (app: Application): void => {
  app.use(createGoogleOAuthRouter());
};
