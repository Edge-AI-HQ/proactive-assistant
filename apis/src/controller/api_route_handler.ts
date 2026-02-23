import type { Application } from 'express';
import type { Server } from 'node:http';
import { registerAuthRoutes } from './auth_routes.js';
import { registerDashboardApiRoutes, registerDashboardRoutes, registerDashboardWsRoutes } from './dashboard_routes.js';
import { registerUserRoutes } from './user_routes.js';
import { registerClawAssistantRoutes } from './claw_assistant_routes.js';
import { registerContainerRoutes } from './container_routes.js';
import { registerPaymentRoutes, registerPaymentWebhookRoutes } from './payment_routes.js';

export const registerRawBodyRoutes = (app: Application): void => {
  // Stripe webhook needs raw body for signature verification.
  registerPaymentWebhookRoutes(app);
};

export const registerHttpRoutes = (app: Application): void => {
  registerUserRoutes(app);
  registerClawAssistantRoutes(app);
  registerContainerRoutes(app);
  registerDashboardApiRoutes(app);
  registerPaymentRoutes(app);

  registerAuthRoutes(app);
  registerDashboardRoutes(app);
};

export const registerWsRoutes = (server: Server): void => {
  registerDashboardWsRoutes(server);
};
