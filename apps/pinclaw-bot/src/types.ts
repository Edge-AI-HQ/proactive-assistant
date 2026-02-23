import type { SharedConfig } from '@pin-ai/shared-types';

export type {
  AssistantMutableFields,
  AssistantRecord,
  CreateAssistantInput,
  CreateUserInput,
  GatewaySessionRecord,
  LiteLLMUsageOverviewRecord,
  SharedConfig,
  UserMutableFields,
  UserRecord
} from '@pin-ai/shared-types';

export interface Config extends SharedConfig {
  backendApi: {
    baseUrl: string;
    internalApiKey: string;
    requestTimeoutMs: number;
  };
}

export type RequiredSecret = [name: string, value: string];
