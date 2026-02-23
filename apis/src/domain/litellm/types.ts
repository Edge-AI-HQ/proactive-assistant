import type {
  AssistantMutableFields as SharedAssistantMutableFields,
  AssistantRecord,
  Config,
  UserMutableFields as SharedUserMutableFields,
  UserRecord
} from '../../types.js';

export type LiteLLMConfig = Config['litellm'];

export interface LiteLLMRuntimeConfig {
  litellm: LiteLLMConfig;
}

type LiteLLMUserMutableField =
  | 'litellm_user_id'
  | 'litellm_user_alias'
  | 'litellm_key_alias'
  | 'litellm_virtual_key'
  | 'litellm_key_last4'
  | 'litellm_spend_usd'
  | 'litellm_budget_usd'
  | 'litellm_budget_duration'
  | 'litellm_rpm_limit'
  | 'litellm_tpm_limit'
  | 'litellm_last_synced_at';

type LiteLLMUserField = 'id' | 'telegram_user_id' | 'telegram_username' | LiteLLMUserMutableField;

export type LiteLLMUserRecord = Pick<UserRecord, LiteLLMUserField>;

export type LiteLLMAssistantRecord = AssistantRecord;

export type LiteLLMUserMutableFields = Pick<SharedUserMutableFields, LiteLLMUserMutableField>;

type LiteLLMAssistantMutableField =
  | 'litellm_user_id'
  | 'litellm_key_alias'
  | 'litellm_virtual_key'
  | 'litellm_key_last4'
  | 'litellm_spend_usd'
  | 'litellm_budget_usd'
  | 'litellm_budget_duration'
  | 'litellm_rpm_limit'
  | 'litellm_tpm_limit'
  | 'litellm_last_synced_at';

export type LiteLLMAssistantMutableFields = Pick<SharedAssistantMutableFields, LiteLLMAssistantMutableField>;

export interface LiteLLMStore {
  getUserByTelegramId(telegramUserId: number): Promise<LiteLLMUserRecord | undefined>;
  listAssistantsByOwnerTelegramId(ownerTelegramUserId: number): Promise<LiteLLMAssistantRecord[]>;
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
