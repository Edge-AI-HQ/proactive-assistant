import { ensureAssistantContainer } from '../container/index.js';
import { ensureLiteLLMKeyForAssistant } from '../litellm/index.js';
import { getUserByTelegramId } from '../common/db/index.js';
import type { AssistantRecord } from '../../types.js';

const warmupInFlight = new Map<number, Promise<AssistantRecord | null>>();

export const ensureGatewayAssistantReady = async (assistant: AssistantRecord): Promise<AssistantRecord | null> => {
  const assistantId = assistant.id;
  const inFlight = warmupInFlight.get(assistantId);
  if (inFlight) return inFlight;

  const job = (async (): Promise<AssistantRecord | null> => {
    const assistantWithKey = await ensureLiteLLMKeyForAssistant(assistant.owner_telegram_user_id, assistant);
    const owner = await getUserByTelegramId(assistant.owner_telegram_user_id);
    if (!owner) {
      throw new Error(`Owner ${assistant.owner_telegram_user_id} not found for assistant ${assistant.id}`);
    }
    const { containerId, ready } = await ensureAssistantContainer(assistantWithKey, owner.gateway_token);
    if (!ready) return null;
    return {
      ...assistantWithKey,
      container_id: containerId,
      container_status: 'running'
    };
  })();

  void job.finally(() => {
    if (warmupInFlight.get(assistantId) === job) {
      warmupInFlight.delete(assistantId);
    }
  });

  warmupInFlight.set(assistantId, job);
  return job;
};
