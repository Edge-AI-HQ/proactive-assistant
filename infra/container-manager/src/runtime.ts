import type { ContainerManagerRuntime } from './types.js';

let runtime: ContainerManagerRuntime | null = null;

export const configureContainerManagerRuntime = (nextRuntime: ContainerManagerRuntime): void => {
  runtime = nextRuntime;
};

export const getContainerManagerRuntime = (): ContainerManagerRuntime => {
  if (!runtime) {
    throw new Error('Container manager runtime is not configured. Call configureContainerManagerRuntime(...) at app startup.');
  }
  return runtime;
};
