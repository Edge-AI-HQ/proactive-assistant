import {
  configureContainerManagerRuntime,
  type ContainerManagerConfig,
  type ContainerStateStore
} from '../container/index.js';
import {
  configureLiteLLMRuntime,
  readAssistantLiteLLMVirtualKey,
  readUserLiteLLMVirtualKey,
  type LiteLLMRuntimeConfig,
  type LiteLLMStore
} from '../litellm/index.js';
import { config } from './config.js';
import {
  getUserByTelegramId,
  listAssistantsByOwnerTelegramId,
  listAssistantsWithLiteLLMKey,
  listUsedPorts,
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
  updateUserById
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
    readAssistantLiteLLMVirtualKey,
    readUserLiteLLMVirtualKey
  });

  configured = true;
};
