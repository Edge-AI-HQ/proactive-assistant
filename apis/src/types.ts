import type { BasePaymentConfig, SharedConfig } from '@pin-ai/shared-types';

export type {
  AssistantMutableFields,
  AssistantRecord,
  BasePaymentConfig,
  CreateAssistantInput,
  CreateUserInput,
  GatewaySessionRecord,
  LiteLLMUsageOverviewRecord,
  SharedConfig,
  UserMutableFields,
  UserRecord
} from '@pin-ai/shared-types';

export interface ApiPaymentConfig extends BasePaymentConfig {
  requestTimeoutMs: number;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePriceIdBasic: string;
  stripePriceIdPro: string;
  stripePriceIdMax: string;
  publicBaseUrl: string;
  telegramBotUsername: string;
  cronSecret: string;
}

export interface Config extends Omit<SharedConfig, 'payment'> {
  apiAuthToken: string;
  payment: ApiPaymentConfig;
}

export type RequiredSecret = [name: string, value: string];
