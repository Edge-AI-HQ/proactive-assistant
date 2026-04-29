import type { LiteLLMConfig } from '../../../../types/index.js';

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
    normalized.includes('kimi') ||
    normalized.includes('claude-opus') ||
    normalized.includes('claude-sonnet') ||
    normalized.includes('claude-haiku') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  );
};

export const buildLiteLLMModelIds = (litellm: LiteLLMConfig): string[] => {
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

export const buildLiteLLMPrimaryModelRef = (litellm: LiteLLMConfig): string =>
  `litellm/${buildLiteLLMModelIds(litellm)[0]}`;

export const buildLiteLLMFallbackModelRefs = (litellm: LiteLLMConfig): string[] =>
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

export const buildLiteLLMModelsAllowlist = (litellm: LiteLLMConfig): UnknownRecord => {
  const modelIds = buildLiteLLMModelIds(litellm);
  const allowlist: UnknownRecord = {};
  for (const id of modelIds) {
    allowlist[`litellm/${id}`] = { alias: inferAliasByModelId(id) };
  }
  return allowlist;
};

export const buildLiteLLMProviderConfig = (
  litellm: LiteLLMConfig,
  apiKey: string
): UnknownRecord => {
  const modelIds = buildLiteLLMModelIds(litellm);
  return {
    baseUrl: normalizeLiteLLMBaseUrlForOpenClaw(litellm.baseUrl),
    apiKey,
    api: 'openai-completions',
    models: modelIds.map((id) => {
      const reasoning = inferReasoningByModelId(id);
      // OpenClaw treats any custom baseUrl as "proxy-like" and auto-disables
      // `supportsReasoningEffort` (see openai-completions-compat.ts). LiteLLM
      // is a proxy but DOES forward `reasoning_effort` correctly to upstream
      // (Moonshot OpenAI-compat, Anthropic translated to `thinking`), so
      // explicitly opt back in via the documented compat override.
      const compat = reasoning ? { supportsReasoningEffort: true } : undefined;
      return {
        id,
        name: id,
        reasoning,
        input: ['text', 'image'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        },
        contextWindow: 200000,
        maxTokens: 64000,
        ...(compat ? { compat } : {})
      };
    })
  };
};
