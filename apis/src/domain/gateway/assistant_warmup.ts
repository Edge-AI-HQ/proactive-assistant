import { ensureAssistantContainer } from '../container/index.js';
import { ensureTelegramUser } from '../user/service.js';
import { ensureLiteLLMKeyForAssistant } from '../litellm/index.js';
import type { AssistantRecord } from '../../types.js';

const warmupInFlight = new Map<number, Promise<AssistantRecord | null>>();

export const ensureGatewayAssistantReady = async (assistant: AssistantRecord): Promise<AssistantRecord | null> => {
  const assistantId = assistant.id;
  const inFlight = warmupInFlight.get(assistantId);
  if (inFlight) return inFlight;

  const job = (async (): Promise<AssistantRecord | null> => {
    const owner = await ensureTelegramUser(assistant.owner_telegram_user_id);
    const assistantWithKey = await ensureLiteLLMKeyForAssistant(assistant.owner_telegram_user_id, assistant);
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
