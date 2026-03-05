import { config } from '../common/config.js';
import type { ContainerRuntime } from './contracts.js';
import { dockerContainerRuntime } from './providers/docker/index.js';
import { flyContainerRuntime } from './providers/fly/index.js';

export const getContainerRuntime = (): ContainerRuntime => {
  return config.container.runtime === 'fly' ? flyContainerRuntime : dockerContainerRuntime;
};

