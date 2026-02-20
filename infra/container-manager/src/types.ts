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

export interface ContainerManagerConfig {
  openclaw: {
    image: string;
    gatewayPort: number;
    apiKey: string;
    braveApiKey: string;
  };
  litellm: {
    enabled: boolean;
    containerBaseUrl: string;
    masterKey: string;
    allowedModels: string[];
    openclawDefaultModel: string;
  };
  elevenLabs: {
    apiKey: string;
    baseUrl: string;
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
}

export interface ContainerStateStore {
  listUsedPorts(): Promise<number[]>;
  updateAssistant(id: number, fields: AssistantMutableFields): Promise<AssistantRecord | undefined>;
  updateUser(telegramUserId: number, fields: UserMutableFields): Promise<UserRecord | undefined>;
  updateUserById(id: number, fields: UserMutableFields): Promise<UserRecord | undefined>;
}

export type ReadAssistantLiteLLMVirtualKey = (
  assistant: Pick<AssistantRecord, 'assistant_bot_id' | 'litellm_virtual_key_encrypted'>
) => string | null;

export interface ContainerManagerRuntime {
  config: ContainerManagerConfig;
  store: ContainerStateStore;
  readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey;
}
