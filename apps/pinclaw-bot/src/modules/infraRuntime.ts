import {
  configureContainerManagerRuntime,
  type ContainerManagerConfig,
  type ContainerStateStore
} from '@pin-ai/infra-container-manager';
import {
  configureLiteLLMRuntime,
  readAssistantLiteLLMVirtualKey,
  type LiteLLMRuntimeConfig,
  type LiteLLMStore
} from '@pin-ai/infra-litellm';
import { config } from '../config.js';
import {
  getUserByTelegramId,
  listAssistantsWithLiteLLMKey,
  listUsedPorts,
  updateAssistant,
  updateUser,
  updateUserById
} from '../db.js';

let configured = false;

const litellmRuntimeConfig: LiteLLMRuntimeConfig = {
  litellm: config.litellm
};

const containerManagerConfig: ContainerManagerConfig = {
  openclaw: config.openclaw,
  litellm: {
    enabled: config.litellm.enabled,
    containerBaseUrl: config.litellm.containerBaseUrl,
    masterKey: config.litellm.masterKey,
    allowedModels: config.litellm.allowedModels,
    openclawDefaultModel: config.litellm.openclawDefaultModel
  },
  elevenLabs: config.elevenLabs,
  container: config.container,
  fly: config.fly
};

const litellmStore: LiteLLMStore = {
  getUserByTelegramId,
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
    readAssistantLiteLLMVirtualKey
  });

  configured = true;
};
