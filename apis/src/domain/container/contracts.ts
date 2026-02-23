import type { AssistantRecord } from './types.js';

export interface GatewayTarget {
  host: string;
  port: number;
  httpBaseUrl: string;
  wsBaseUrl: string;
}

export type AssistantContainerRuntimeRef = Pick<
  AssistantRecord,
  | 'id'
  | 'owner_telegram_user_id'
  | 'assistant_bot_id'
  | 'assistant_bot_token'
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
>;

export type AssistantContainerDestroyRef = Pick<
  AssistantRecord,
  'id' | 'assistant_bot_id' | 'container_name' | 'container_id'
>;

export type AssistantContainerGatewayRef = Pick<
  AssistantRecord,
  'assistant_bot_id' | 'container_id' | 'container_port'
>;

export interface ContainerProvider {
  prepareRuntime(): Promise<void> | void;
  ensureAssistantContainer(
    assistant: AssistantContainerRuntimeRef,
    gatewayToken: string
  ): Promise<{ containerId: string; ready: boolean }>;
  destroyAssistantContainer(assistant: AssistantContainerDestroyRef): Promise<{ deleted: boolean }>;
  resolveGatewayTargetForAssistant(assistant: AssistantContainerGatewayRef): GatewayTarget;
}
