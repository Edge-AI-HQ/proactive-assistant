import type {
  AssistantMutableFields as SharedAssistantMutableFields,
  AssistantRecord as SharedAssistantRecord,
  Config,
  UserMutableFields as SharedUserMutableFields,
  UserRecord as SharedUserRecord
} from '../../types.js';

export type UserRecord = SharedUserRecord;
export type AssistantRecord = SharedAssistantRecord;
export type UserMutableFields = SharedUserMutableFields;
export type AssistantMutableFields = SharedAssistantMutableFields;

type ContainerLiteLLMConfig = Pick<
  Config['litellm'],
  'enabled' | 'baseUrl' | 'masterKey' | 'allowedModels' | 'openclawDefaultModel'
>;

export type ContainerManagerConfig = Pick<Config, 'openclaw' | 'elevenLabs' | 'container' | 'fly' | 'telegram' | 'telegramRouter'> & {
  litellm: ContainerLiteLLMConfig;
};

export interface ContainerStateStore {
  listUsedPorts(): Promise<number[]>;
  updateAssistant(id: number, fields: AssistantMutableFields): Promise<AssistantRecord | undefined>;
  updateUser(telegramUserId: number, fields: UserMutableFields): Promise<UserRecord | undefined>;
  updateUserById(id: number, fields: UserMutableFields): Promise<UserRecord | undefined>;
  readAssistantRuntimeMetadata(assistantId: number): Promise<Record<string, unknown>>;
}

export type ReadAssistantLiteLLMVirtualKey = (
  assistant: Pick<AssistantRecord, 'assistant_bot_id' | 'litellm_virtual_key'>
) => string | null;

export type ReadUserLiteLLMVirtualKey = (
  user: Pick<UserRecord, 'telegram_user_id' | 'litellm_virtual_key'>
) => string | null;

export interface ContainerNotifier {
  notifyReady(
    telegramUserId: number,
    options?: { assistantId?: number },
  ): Promise<void>;
  notifyError?(
    telegramUserId: number,
    options?: { assistantId?: number },
  ): Promise<void>;
}

export interface ContainerManagerRuntime {
  config: ContainerManagerConfig;
  store: ContainerStateStore;
  notifier: ContainerNotifier;
  readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey;
  readUserLiteLLMVirtualKey: ReadUserLiteLLMVirtualKey;
}
