export interface UserRecord {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  litellm_user_id: string | null;
  litellm_user_alias: string | null;
  container_id: string;
  container_port: number;
  container_status: string;
  gateway_token: string;
  assistant_bot_token: string | null;
  assistant_bot_username: string | null;
  assistant_webhook_secret: string | null;
  created_at: string;
  last_active_at: string;
}

export interface AssistantRecord {
  id: number;
  owner_telegram_user_id: number;
  assistant_bot_id: number;
  assistant_bot_token: string;
  assistant_bot_username: string;
  litellm_user_id: string | null;
  litellm_key_alias: string | null;
  litellm_virtual_key_encrypted: string | null;
  litellm_key_last4: string | null;
  litellm_spend_usd: number;
  litellm_budget_usd: number | null;
  litellm_budget_duration: string | null;
  litellm_rpm_limit: number | null;
  litellm_tpm_limit: number | null;
  litellm_last_synced_at: string | null;
  container_name: string;
  container_id: string;
  container_port: number;
  container_status: string;
  created_at: string;
  updated_at: string;
}

export interface GatewaySessionRecord {
  id: number;
  telegram_user_id: number;
  session_token: string;
  created_at: string;
  expires_at: string;
}

export interface MessageLogRecord {
  id: number;
  telegram_user_id: number;
  direction: string | null;
  message_text: string | null;
  created_at: string;
}

export interface AdminUserRecord {
  id: number;
  username: string;
  password_hash: string;
  email: string | null;
  created_at: string;
}

export interface AdminSessionRecord {
  id: number;
  admin_id: number;
  session_token: string;
  expires_at: string;
}

export interface AdminSessionView extends AdminSessionRecord {
  admin_username: string;
}

export interface CreateUserInput {
  telegram_user_id: number;
  telegram_username?: string | null;
  litellm_user_id?: string | null;
  litellm_user_alias?: string | null;
  container_id: string;
  container_port: number;
  container_status?: string;
  gateway_token: string;
  assistant_bot_token?: string | null;
  assistant_bot_username?: string | null;
  assistant_webhook_secret?: string | null;
}

export interface CreateAssistantInput {
  owner_telegram_user_id: number;
  assistant_bot_id: number;
  assistant_bot_token: string;
  assistant_bot_username: string;
  litellm_user_id?: string | null;
  litellm_key_alias?: string | null;
  litellm_virtual_key_encrypted?: string | null;
  litellm_key_last4?: string | null;
  litellm_spend_usd?: number;
  litellm_budget_usd?: number | null;
  litellm_budget_duration?: string | null;
  litellm_rpm_limit?: number | null;
  litellm_tpm_limit?: number | null;
  litellm_last_synced_at?: string | null;
  container_name: string;
  container_id: string;
  container_port: number;
  container_status?: string;
}

export type UserMutableFields = Partial<
  Pick<
    UserRecord,
    | 'telegram_username'
    | 'litellm_user_id'
    | 'litellm_user_alias'
    | 'container_id'
    | 'container_port'
    | 'container_status'
    | 'gateway_token'
    | 'assistant_bot_token'
    | 'assistant_bot_username'
    | 'assistant_webhook_secret'
  >
>;

export type AssistantMutableFields = Partial<
  Pick<
    AssistantRecord,
    | 'assistant_bot_token'
    | 'assistant_bot_username'
    | 'litellm_user_id'
    | 'litellm_key_alias'
    | 'litellm_virtual_key_encrypted'
    | 'litellm_key_last4'
    | 'litellm_spend_usd'
    | 'litellm_budget_usd'
    | 'litellm_budget_duration'
    | 'litellm_rpm_limit'
    | 'litellm_tpm_limit'
    | 'litellm_last_synced_at'
    | 'container_name'
    | 'container_id'
    | 'container_port'
    | 'container_status'
  >
>;

export interface TokenUsageLedgerInput {
  telegram_user_id: number;
  session_key: string;
  run_id: string;
  idempotency_key: string;
  provider?: string | null;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface TokenUsageLedgerRecord {
  id: number;
  telegram_user_id: number;
  session_key: string;
  run_id: string;
  idempotency_key: string;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface UserUsageTotalsRecord {
  telegram_user_id: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  updated_at: string;
}

export interface UserWithUsageRecord extends UserRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface UsageOverviewRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface LiteLLMUsageOverviewRecord {
  assistants_with_keys: number;
  assistants_over_budget: number;
  total_spend_usd: number;
}

export interface Config {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  apiDomain: string;
  databasePath: string;
  telegram: {
    token: string;
    webhookSecret: string;
    botUsername: string;
  };
  openclaw: {
    image: string;
    gatewayPort: number;
    httpPath: string;
    wsPath: string;
    apiKey: string;
    braveApiKey: string;
  };
  litellm: {
    enabled: boolean;
    baseUrl: string;
    containerBaseUrl: string;
    masterKey: string;
    keyEncryptionSecret: string;
    requestTimeoutMs: number;
    syncIntervalMs: number;
    userIdPrefix: string;
    keyAliasPrefix: string;
    defaultBudgetUsd: number | null;
    defaultBudgetDuration: string;
    defaultRpmLimit: number | null;
    defaultTpmLimit: number | null;
    allowedModels: string[];
    openclawDefaultModel: string;
    allowProviderFallback: boolean;
  };
  anthropicApiKey: string;
  openaiApiKey: string;
  elevenLabs: {
    apiKey: string;
    baseUrl: string;
    sttModel: string;
  };
  admin: {
    username: string;
    passwordHash: string;
    sessionSecret: string;
    sessionTtlHours: number;
  };
  container: {
    runtime: 'docker' | 'fly';
    portStart: number;
    portEnd: number;
    memoryMb: number;
    cpuShares: number;
  };
  fly: {
    apiBaseUrl: string;
    apiToken: string;
    appName: string;
    region: string;
    volumeSizeGb: number;
    volumeNamePrefix: string;
    machineCpus: number;
    gatewayProbe: boolean;
    gatewayProbeTimeoutMs: number;
  };
  supabase: {
    url: string;
    serviceKey: string;
  };
  featureFlags: {
    allowMissingSecrets: boolean;
  };
}

export type RequiredSecret = [name: string, value: string];
