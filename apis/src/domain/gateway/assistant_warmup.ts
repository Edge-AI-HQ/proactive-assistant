import { ensureAssistantContainer } from '../container/index.js';
import { ensureTelegramUser } from '../user/service.js';
import { ensureLiteLLMKeyForAssistant } from '../litellm/index.js';
import type { AssistantRecord } from '../../types.js';

type EnsureGatewayAssistantReadyOptions = {
  allowRecreate?: boolean;
};

const warmupInFlight = new Map<string, Promise<AssistantRecord | null>>();

export const ensureGatewayAssistantReady = async (
  assistant: AssistantRecord,
  options?: EnsureGatewayAssistantReadyOptions,
): Promise<AssistantRecord | null> => {
  const assistantId = assistant.id;
  const allowRecreate = options?.allowRecreate !== false;
  const key = `${assistantId}:${allowRecreate ? 'recreate' : 'no-recreate'}`;
  const inFlight = warmupInFlight.get(key);
  if (inFlight) return inFlight;

  const job = (async (): Promise<AssistantRecord | null> => {
    const owner = await ensureTelegramUser(assistant.owner_telegram_user_id);
    const assistantWithKey = await ensureLiteLLMKeyForAssistant(assistant.owner_telegram_user_id, assistant);
    const { containerId, ready } = await ensureAssistantContainer(
      assistantWithKey,
      owner.gateway_token,
      { allowRecreate },
    );
    if (!ready) return null;
    return {
      ...assistantWithKey,
      container_id: containerId,
      container_status: 'running'
    };
  })();

  void job.finally(() => {
    if (warmupInFlight.get(key) === job) {
      warmupInFlight.delete(key);
    }
  });

  warmupInFlight.set(key, job);
  return job;
};
