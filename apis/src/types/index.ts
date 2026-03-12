export interface UserRecord {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  litellm_user_id: string | null;
  litellm_user_alias: string | null;
  litellm_key_alias: string | null;
  litellm_virtual_key: string | null;
  litellm_key_last4: string | null;
  litellm_spend_usd: number;
  litellm_budget_usd: number | null;
  litellm_budget_duration: string | null;
  litellm_rpm_limit: number | null;
  litellm_tpm_limit: number | null;
  litellm_last_synced_at: string | null;
  container_id: string;
  container_port: number;
  container_status: string;
  gateway_token: string;
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
  litellm_virtual_key: string | null;
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

export interface LiteLLMUsageOverviewRecord {
  assistants_with_keys: number;
  assistants_over_budget: number;
  total_spend_usd: number;
}

export interface CreateUserInput {
  telegram_user_id: number;
  telegram_username?: string | null;
  litellm_user_id?: string | null;
  litellm_user_alias?: string | null;
  litellm_key_alias?: string | null;
  litellm_virtual_key?: string | null;
  litellm_key_last4?: string | null;
  litellm_spend_usd?: number;
  litellm_budget_usd?: number | null;
  litellm_budget_duration?: string | null;
  litellm_rpm_limit?: number | null;
  litellm_tpm_limit?: number | null;
  litellm_last_synced_at?: string | null;
  container_id?: string;
  container_port?: number;
  container_status?: string;
  gateway_token: string;
}

export interface CreateAssistantInput {
  owner_telegram_user_id: number;
  assistant_bot_id: number | null;
  assistant_bot_token: string | null;
  assistant_bot_username: string | null;
  litellm_user_id?: string | null;
  litellm_key_alias?: string | null;
  litellm_virtual_key?: string | null;
  litellm_key_last4?: string | null;
  litellm_spend_usd?: number;
  litellm_budget_usd?: number | null;
  litellm_budget_duration?: string | null;
  litellm_rpm_limit?: number | null;
  litellm_tpm_limit?: number | null;
  litellm_last_synced_at?: string | null;
  container_name: string;
  container_id: string;
  container_port?: number;
  container_status?: string;
}

export type UserMutableFields = Partial<
  Pick<
    UserRecord,
    | "telegram_username"
    | "litellm_user_id"
    | "litellm_user_alias"
    | "litellm_key_alias"
    | "litellm_virtual_key"
    | "litellm_key_last4"
    | "litellm_spend_usd"
    | "litellm_budget_usd"
    | "litellm_budget_duration"
    | "litellm_rpm_limit"
    | "litellm_tpm_limit"
    | "litellm_last_synced_at"
    | "container_id"
    | "container_port"
    | "container_status"
    | "gateway_token"
  >
>;

export type AssistantMutableFields = Partial<
  Pick<
    AssistantRecord,
    | "assistant_bot_id"
    | "assistant_bot_token"
    | "assistant_bot_username"
    | "litellm_user_id"
    | "litellm_key_alias"
    | "litellm_virtual_key"
    | "litellm_key_last4"
    | "litellm_spend_usd"
    | "litellm_budget_usd"
    | "litellm_budget_duration"
    | "litellm_rpm_limit"
    | "litellm_tpm_limit"
    | "litellm_last_synced_at"
    | "container_name"
    | "container_id"
    | "container_port"
    | "container_status"
  >
>;

export interface TelegramConfig {
  token: string;
  webhookSecret: string;
  botUsername: string;
}

export interface OpenclawConfig {
  image: string;
  gatewayPort: number;
  braveApiKey: string;
}

export interface LiteLLMConfig {
  enabled: boolean;
  baseUrl: string;
  masterKey: string;
  requestTimeoutMs: number;
  syncIntervalMs: number;
  keyAliasPrefix: string;
  defaultBudgetUsd: number | null;
  defaultBudgetDuration: string;
  defaultRpmLimit: number | null;
  defaultTpmLimit: number | null;
  allowedModels: string[];
  openclawDefaultModel: string;
}

export interface ElevenLabsConfig {
  apiKey: string;
  baseUrl: string;
}

export interface SupabaseConfig {
  dbUrl: string;
}

export interface BasePaymentConfig {
  /** Reserved for extension. Payment is always on when Stripe is configured. */
}

export interface ContainerConfig {
  runtime: "docker" | "fly";
  portStart: number;
  portEnd: number;
  memoryMb: number;
  cpuShares: number;
}

export interface FlyConfig {
  apiBaseUrl: string;
  apiToken: string;
  appName: string;
  assistantAppName: string;
  region: string;
  regionFallbacks: string[];
  volumeSizeGb: number;
  volumeNamePrefix: string;
  machineCpus: number;
  gatewayProbe: boolean;
  gatewayProbeTimeoutMs: number;
}

export interface TelegramRouterConfig {
  webhookUrl: string;
  webhookPath: string;
  webhookHost: string;
  webhookPort: number;
  pluginLoadPaths: string[];
}

export interface FeatureFlagsConfig {
  allowMissingSecrets: boolean;
}

export interface LegacyProfileConfig {
  mysqlUrl: string;
}

export interface SharedConfig {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  telegram: TelegramConfig;
  openclaw: OpenclawConfig;
  litellm: LiteLLMConfig;
  anthropicApiKey: string;
  openaiApiKey: string;
  elevenLabs: ElevenLabsConfig;
  supabase: SupabaseConfig;
  payment: BasePaymentConfig;
  container: ContainerConfig;
  fly: FlyConfig;
  telegramRouter: TelegramRouterConfig;
  featureFlags: FeatureFlagsConfig;
  legacyProfile: LegacyProfileConfig;
}
