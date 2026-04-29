import type { Application } from "express";
import type { Server } from "node:http";
import {
  registerPaymentRoutes,
  registerPaymentWebhookRoutes,
} from "./payment_routes.js";
import { registerProactiveRoutes, registerProactiveWsRoutes } from "./proactive_routes.js";

export const registerRawBodyRoutes = (app: Application): void => {
  // Stripe webhook needs raw body for signature verification.
  registerPaymentWebhookRoutes(app);
};

export const registerHttpRoutes = (app: Application): void => {
  registerPaymentRoutes(app);
  registerProactiveRoutes(app);
};

export const registerWsRoutes = (server: Server): void => {
  registerProactiveWsRoutes(server);
};
