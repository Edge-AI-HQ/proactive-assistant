import type { ContainerManagerConfig } from '../../types.js';

export type UnknownRecord = Record<string, unknown>;

const normalizeLiteLLMModelId = (value: string): string => value.trim().replace(/^litellm\//i, '');

const normalizeLiteLLMBaseUrlForOpenClaw = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
};

const inferReasoningByModelId = (id: string): boolean => {
  const normalized = id.toLowerCase();
  return (
    normalized.includes('thinking') ||
    normalized.includes('reason') ||
    normalized.includes('r1') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  );
};

export const buildLiteLLMModelIds = (litellm: ContainerManagerConfig['litellm']): string[] => {
  const ids: string[] = [];
  const pushUnique = (candidate: string): void => {
    const normalized = normalizeLiteLLMModelId(candidate);
    if (!normalized) return;
    if (!ids.includes(normalized)) ids.push(normalized);
  };

  pushUnique(litellm.openclawDefaultModel);
  litellm.allowedModels.forEach((model) => pushUnique(model));

  if (!ids.length) {
    ids.push('claude-opus-4-6');
  }

  return ids;
};

export const buildLiteLLMPrimaryModelRef = (litellm: ContainerManagerConfig['litellm']): string =>
  `litellm/${buildLiteLLMModelIds(litellm)[0]}`;

export const buildLiteLLMFallbackModelRefs = (litellm: ContainerManagerConfig['litellm']): string[] =>
  buildLiteLLMModelIds(litellm).slice(1).map((id) => `litellm/${id}`);

const inferAliasByModelId = (id: string): string => {
  const normalized = id.toLowerCase();
  // Extract a short, memorable alias from the model id
  if (normalized.includes('kimi')) return 'kimi';
  if (normalized.includes('claude') && normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('claude') && normalized.includes('opus')) return 'opus';
  if (normalized.includes('minimax')) return 'minimax';
  if (normalized.includes('gpt-4o-mini')) return 'gpt-mini';
  if (normalized.includes('gpt')) return 'gpt';
  if (normalized.includes('seed')) return 'seed';
  // Fallback: use the id itself
  return id;
};

export const buildLiteLLMModelsAllowlist = (litellm: ContainerManagerConfig['litellm']): UnknownRecord => {
  const modelIds = buildLiteLLMModelIds(litellm);
  const allowlist: UnknownRecord = {};
  for (const id of modelIds) {
    allowlist[`litellm/${id}`] = { alias: inferAliasByModelId(id) };
  }
  return allowlist;
};

export const buildLiteLLMProviderConfig = (
  litellm: ContainerManagerConfig['litellm'],
  apiKey: string
): UnknownRecord => {
  const modelIds = buildLiteLLMModelIds(litellm);
  return {
    baseUrl: normalizeLiteLLMBaseUrlForOpenClaw(litellm.containerBaseUrl),
    apiKey,
    api: 'openai-completions',
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: inferReasoningByModelId(id),
      input: ['text', 'image'],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 200000,
      maxTokens: 64000
    }))
  };
};
