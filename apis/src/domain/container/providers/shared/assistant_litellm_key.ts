import type { AssistantContainerRuntimeRef } from '../../contracts.js';
import type { ReadAssistantLiteLLMVirtualKey } from '../../types.js';

export const resolveAssistantLiteLLMApiKey = (
  assistant: AssistantContainerRuntimeRef,
  litellmEnabled: boolean,
  readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey
): string | null => {
  if (!litellmEnabled) return null;
  const key = readAssistantLiteLLMVirtualKey(assistant);
  if (!key) {
    throw new Error(`Assistant ${assistant.assistant_bot_id} missing LiteLLM virtual key`);
  }
  return key;
};
