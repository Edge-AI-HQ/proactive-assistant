import { config } from '../common/config.js';
import type { ContainerProvider } from './contracts.js';
import { dockerContainerProvider } from './providers/docker/index.js';
import { flyContainerProvider } from './providers/fly/index.js';

export const getContainerProvider = (): ContainerProvider => {
  return config.container.runtime === 'fly' ? flyContainerProvider : dockerContainerProvider;
};
