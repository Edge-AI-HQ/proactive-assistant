import {
  configureContainerManagerRuntime,
  type ContainerManagerConfig,
  type ContainerStateStore
} from '../container/index.js';
import type { ContainerNotifier } from '../container/types.js';
import {
  configureLiteLLMRuntime,
  readAssistantLiteLLMVirtualKey,
  readUserLiteLLMVirtualKey,
  type LiteLLMRuntimeConfig,
  type LiteLLMStore
} from '../litellm/index.js';
import { sendTelegramMessage } from '../telegram/notify.js';
import { config } from './config.js';
import { triggerReadyGreetingForAssistant } from '../onboarding/ready_greeting.js';
import {
  getUserByTelegramId,
  listAssistantsByOwnerTelegramId,
  listAssistantsWithLiteLLMKey,
  listUsedPorts,
  readAssistantRuntimeMetadata,
  setAssistantRuntimeMetadataKeyIfAbsent,
  updateAssistant,
  updateUser,
  updateUserById
} from './db/index.js';

let configured = false;

const litellmRuntimeConfig: LiteLLMRuntimeConfig = {
  litellm: config.litellm
};

const containerManagerConfig: ContainerManagerConfig = {
  openclaw: config.openclaw,
  litellm: {
    enabled: config.litellm.enabled,
    baseUrl: config.litellm.baseUrl,
    containerBaseUrl: config.litellm.containerBaseUrl,
    masterKey: config.litellm.masterKey,
    allowedModels: config.litellm.allowedModels,
    openclawDefaultModel: config.litellm.openclawDefaultModel
  },
  elevenLabs: config.elevenLabs,
  container: config.container,
  fly: config.fly,
  telegram: config.telegram,
  telegramRouter: config.telegramRouter
};

const litellmStore: LiteLLMStore = {
  getUserByTelegramId,
  listAssistantsByOwnerTelegramId,
  listAssistantsWithLiteLLMKey,
  updateAssistant,
  updateUser
};

const containerStateStore: ContainerStateStore = {
  listUsedPorts,
  updateAssistant,
  updateUser,
  updateUserById,
  readAssistantRuntimeMetadata
};

const containerNotifier: ContainerNotifier = {
  async notifyReady(
    telegramUserId: number,
    options?: { assistantId?: number },
  ): Promise<void> {
    if (options?.assistantId) {
      const readyNotifyClaimed = await setAssistantRuntimeMetadataKeyIfAbsent(
        options.assistantId,
        "onboarding_ready_notified_at",
        new Date().toISOString(),
      ).catch((error) => {
        console.warn(
          `[container] failed to claim ready notification lock for assistant ${options.assistantId}`,
          error,
        );
        return false;
      });

      if (readyNotifyClaimed) {
        await sendTelegramMessage(
          telegramUserId,
          `✅ <b>Your assistant is ready!</b>\n\nYou can start chatting now.`,
        ).catch((e) =>
          console.warn(`[container] notify failed for user ${telegramUserId}`, e),
        );
      }

      const delivered = await triggerReadyGreetingForAssistant({
        assistantId: options.assistantId,
        telegramUserId,
      }).catch((e) => {
        console.warn(
          `[container] onboarding greeting failed for assistant ${options.assistantId}`,
          e,
        );
        return false;
      });
      if (!delivered) {
        console.warn(
          `[container] onboarding greeting not delivered for assistant ${options.assistantId}`,
        );
      }
      return;
    }

    await sendTelegramMessage(
      telegramUserId,
      `✅ <b>Your assistant is ready!</b>\n\nYou can start chatting now.`,
    ).catch((e) =>
      console.warn(`[container] notify failed for user ${telegramUserId}`, e),
    );
  },
};

export const ensureInfraRuntimeConfigured = (): void => {
  if (configured) return;

  configureLiteLLMRuntime({
    config: litellmRuntimeConfig,
    store: litellmStore
  });

  configureContainerManagerRuntime({
    config: containerManagerConfig,
    store: containerStateStore,
    notifier: containerNotifier,
    readAssistantLiteLLMVirtualKey,
    readUserLiteLLMVirtualKey
  });

  configured = true;
};
