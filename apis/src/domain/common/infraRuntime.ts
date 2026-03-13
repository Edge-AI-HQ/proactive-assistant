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
import { sendApiReadyGreetingForAssistant } from '../onboarding/ready_greeting.js';
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
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const ASSISTANT_READY_FIXED_MESSAGE =
  [
    "✅ Your assistant is ready! You can start chatting now. Just use it as your personal assistant.",
    "",
    "Try one of these use cases:",
    "• 🌅 Custom Morning Brief: daily push with key news, top tasks, and suggested next actions.",
    "• 📬 Inbox De-clutter: summarize newsletters and unread threads, then draft replies.",
    "• 👤 Family Calendar & Household Assistant: merge family schedules and monitor upcoming events.",
    "• 🌐 Agent Browser tasks: research websites, compare options, and fill forms.",
  ].join("\n");

interface AssistantReadyNotificationArgs {
  assistantId: number | null;
  telegramUserId: number;
  claimReadyNotifyLock: (
    assistantId: number,
    key: string,
    value: string,
  ) => Promise<boolean>;
  sendFixedReadyMessage: (telegramUserId: number, message: string) => Promise<void>;
  sendHiPinReadyGreeting: (input: {
    assistantId: number;
    telegramUserId: number;
  }) => Promise<boolean>;
}

const litellmRuntimeConfig: LiteLLMRuntimeConfig = {
  litellm: config.litellm
};

const containerManagerConfig: ContainerManagerConfig = {
  openclaw: config.openclaw,
  litellm: {
    enabled: config.litellm.enabled,
    baseUrl: config.litellm.baseUrl,
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

const executeAssistantReadyNotifications = async (
  args: AssistantReadyNotificationArgs,
): Promise<void> => {
  if (!args.assistantId) {
    await args.sendFixedReadyMessage(
      args.telegramUserId,
      ASSISTANT_READY_FIXED_MESSAGE,
    ).catch((e) =>
      console.warn(`[container] notify failed for user ${args.telegramUserId}`, e),
    );
    return;
  }

  const readyNotifyClaimed = await args.claimReadyNotifyLock(
    args.assistantId,
    "onboarding_ready_notified_at",
    new Date().toISOString(),
  ).catch((error) => {
    console.warn(
      `[container] failed to claim ready notification lock for assistant ${args.assistantId}`,
      error,
    );
    return false;
  });
  if (!readyNotifyClaimed) return;

  await args.sendFixedReadyMessage(
    args.telegramUserId,
    ASSISTANT_READY_FIXED_MESSAGE,
  ).catch((e) =>
    console.warn(`[container] notify failed for user ${args.telegramUserId}`, e),
  );

  const hiPinSent = await args.sendHiPinReadyGreeting({
    assistantId: args.assistantId,
    telegramUserId: args.telegramUserId,
  }).catch((e) =>
    console.warn(
      `[container] PIN Claw ready greeting failed for user ${args.telegramUserId}`,
      e,
    ),
  );
  console.info("[container] PIN Claw ready greeting dispatch finished", {
    assistantId: args.assistantId,
    telegramUserId: args.telegramUserId,
    hiPinSent: Boolean(hiPinSent),
  });
};

const containerNotifier: ContainerNotifier = {
  async notifyReady(
    telegramUserId: number,
    options?: { assistantId?: number },
  ): Promise<void> {
    await executeAssistantReadyNotifications({
      assistantId: options?.assistantId ?? null,
      telegramUserId,
      claimReadyNotifyLock: setAssistantRuntimeMetadataKeyIfAbsent,
      sendFixedReadyMessage: async (targetTelegramUserId, message) => {
        await sendTelegramMessage(targetTelegramUserId, message);
      },
      sendHiPinReadyGreeting: sendApiReadyGreetingForAssistant,
    });
  },
};

export const executeAssistantReadyNotificationsForTest =
  executeAssistantReadyNotifications;

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
