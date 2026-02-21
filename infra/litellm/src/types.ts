export interface LiteLLMConfig {
  enabled: boolean;
  baseUrl: string;
  containerBaseUrl: string;
  masterKey: string;
  keyEncryptionSecret: string;
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

export interface LiteLLMRuntimeConfig {
  litellm: LiteLLMConfig;
}

export interface LiteLLMUserRecord {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  litellm_user_id: string | null;
  litellm_user_alias: string | null;
}

export interface LiteLLMAssistantRecord {
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

export type LiteLLMUserMutableFields = Partial<Pick<LiteLLMUserRecord, 'litellm_user_id' | 'litellm_user_alias'>>;

export type LiteLLMAssistantMutableFields = Partial<
  Pick<
    LiteLLMAssistantRecord,
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
  >
>;

export interface LiteLLMStore {
  getUserByTelegramId(telegramUserId: number): Promise<LiteLLMUserRecord | undefined>;
  listAssistantsWithLiteLLMKey(): Promise<LiteLLMAssistantRecord[]>;
  updateAssistant(
    id: number,
    fields: LiteLLMAssistantMutableFields
  ): Promise<LiteLLMAssistantRecord | undefined>;
  updateUser(telegramUserId: number, fields: LiteLLMUserMutableFields): Promise<LiteLLMUserRecord | undefined>;
}

export interface LiteLLMRuntime {
  config: LiteLLMRuntimeConfig;
  store: LiteLLMStore;
}

export interface LiteLLMSyncSummary {
  synced: number;
  failed: number;
  details: Array<{ assistantId: number; message: string }>;
}
