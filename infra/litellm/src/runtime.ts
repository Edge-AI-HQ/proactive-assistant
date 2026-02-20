import type { LiteLLMRuntime } from './types.js';

let runtime: LiteLLMRuntime | null = null;

export const configureLiteLLMRuntime = (nextRuntime: LiteLLMRuntime): void => {
  runtime = nextRuntime;
};

export const getLiteLLMRuntime = (): LiteLLMRuntime => {
  if (!runtime) {
    throw new Error('LiteLLM runtime is not configured. Call configureLiteLLMRuntime(...) at app startup.');
  }
  return runtime;
};
